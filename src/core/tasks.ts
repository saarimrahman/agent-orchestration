import type { Db } from './db.ts';
import { nowIso, tx } from './db.ts';
import { defaultProject, requireProject } from './projects.ts';
import { nextCronFire } from './time.ts';
import type { DepKind, Status, Task, TaskView } from './types.ts';
import { CLOSED_STATUSES, DEP_KINDS, STATUSES } from './types.ts';

/** group_concat delimiter. ASCII unit separator, so tag text can't collide with it. */
const SEP = String.fromCharCode(31);

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * The single definition of "claimable". Shared verbatim by the ready-queue
 * SELECT and the claim UPDATE so the two can never disagree about what is
 * available — a task that shows up in `ready` is a task `claim` will accept.
 *
 * An `in_progress` task whose lease has lapsed is claimable again: that is what
 * stops a crashed agent from stranding work forever.
 *
 * Takes three `?` parameters, all the current timestamp.
 */
const CLAIMABLE = `
  (
    t.status IN ('backlog','ready')
    OR (t.status = 'in_progress' AND t.lease_expires_at IS NOT NULL
        AND t.lease_expires_at <= ?)
  )
  AND (t.snooze_until IS NULL OR t.snooze_until <= ?)
  AND (t.assignee IS NULL OR (t.lease_expires_at IS NOT NULL AND t.lease_expires_at <= ?))
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM deps d JOIN tasks b ON b.id = d.depends_on_id
    WHERE d.task_id = t.id AND d.kind = 'blocks' AND b.status NOT IN (${CLOSED_LIST})
  )
`;

/** Overdue first, then priority, then soonest due, then oldest. */
const QUEUE_ORDER = `
  ORDER BY
    CASE WHEN t.due_at IS NOT NULL AND t.due_at <= ? THEN 0 ELSE 1 END,
    t.priority,
    t.due_at IS NULL,
    t.due_at,
    t.created_at
`;

const SELECT_VIEW = `
  SELECT t.*,
    p.key AS project_key, p.name AS project_name, p.color AS project_color,
    (SELECT group_concat(tg.name, '${SEP}') FROM task_tags tt
       JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = t.id) AS tags_raw,
    (SELECT group_concat(b.ref, '${SEP}') FROM deps d JOIN tasks b ON b.id = d.depends_on_id
       WHERE d.task_id = t.id AND d.kind = 'blocks'
         AND b.status NOT IN (${CLOSED_LIST})) AS blocked_by_raw,
    (SELECT group_concat(o.ref, '${SEP}') FROM deps d JOIN tasks o ON o.id = d.task_id
       WHERE d.depends_on_id = t.id AND d.kind = 'blocks') AS blocks_raw,
    (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
    (SELECT c.body FROM comments c WHERE c.task_id = t.id AND c.kind = 'question'
       ORDER BY c.id DESC LIMIT 1) AS question,
    (SELECT c.author FROM comments c WHERE c.task_id = t.id AND c.kind = 'question'
       ORDER BY c.id DESC LIMIT 1) AS question_from
  FROM tasks t JOIN projects p ON p.id = t.project_id
`;

function split(raw: unknown): string[] {
  return typeof raw === 'string' && raw.length ? raw.split(SEP) : [];
}

function toView(row: Record<string, unknown>): TaskView {
  const { tags_raw, blocked_by_raw, blocks_raw, question, question_from, ...rest } = row;
  const base = rest as unknown as Task & {
    project_key: string;
    project_name: string;
    project_color: string;
    comment_count: number;
  };
  // A question only counts as outstanding while the task is actually waiting on
  // one; once answered, the comment stays in the thread but stops being a prompt.
  const waiting = base.status === 'needs_input';
  return {
    ...base,
    tags: split(tags_raw),
    blocked_by: split(blocked_by_raw),
    blocks: split(blocks_raw),
    question: waiting ? ((question as string | null) ?? null) : null,
    question_from: waiting ? ((question_from as string | null) ?? null) : null,
  };
}

export function logEvent(
  db: Db,
  taskId: number | null,
  actor: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  db.prepare(
    'INSERT INTO events (task_id, actor, field, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    taskId,
    actor,
    field,
    oldValue === null || oldValue === undefined ? null : String(oldValue),
    newValue === null || newValue === undefined ? null : String(newValue),
    nowIso(),
  );
}

// ---------------------------------------------------------------- lookups

export function getTaskById(db: Db, id: number): TaskView | null {
  const row = db.prepare(`${SELECT_VIEW} WHERE t.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toView(row) : null;
}

/** Resolve a `demo-4` style ref, or a bare number treated as the global task id. */
export function findTask(db: Db, ident: string): TaskView | null {
  const trimmed = String(ident).trim();
  if (/^\d+$/.test(trimmed)) return getTaskById(db, Number(trimmed));
  const row = db
    .prepare(`${SELECT_VIEW} WHERE lower(t.ref) = lower(?)`)
    .get(trimmed) as Record<string, unknown> | undefined;
  return row ? toView(row) : null;
}

export function requireTask(db: Db, ident: string): TaskView {
  const task = findTask(db, ident);
  if (task) return task;
  throw new Error(
    `No task "${ident}". Refs look like "demo-4"; a bare number is treated as a task id. ` +
      `Run "orchestration ls" to see what exists.`,
  );
}

// ---------------------------------------------------------------- create

export type CreateInput = {
  title: string;
  project?: string;
  body?: string;
  priority?: number;
  status?: Status;
  assignee?: string;
  dueAt?: Date | null;
  snoozeUntil?: Date | null;
  recur?: string | null;
  tags?: string[];
  dependsOn?: string[];
  actor: string;
};

export function createTask(db: Db, input: CreateInput): TaskView {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title.');
  if (input.priority !== undefined && (input.priority < 0 || input.priority > 3)) {
    throw new Error(`Priority must be 0-3 (0 is highest). Got ${input.priority}.`);
  }
  if (input.status && !STATUSES.includes(input.status)) {
    throw new Error(`Unknown status "${input.status}". Valid: ${STATUSES.join(', ')}.`);
  }

  const project = input.project ? requireProject(db, input.project) : defaultProject(db);
  const blockers = (input.dependsOn ?? []).map((ident) => requireTask(db, ident));

  return tx(db, () => {
    const seq =
      ((
        db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM tasks WHERE project_id = ?')
          .get(project.id) as { m: number }
      ).m ?? 0) + 1;
    const ref = `${project.key}-${seq}`;
    const ts = nowIso();

    const info = db
      .prepare(
        `INSERT INTO tasks
           (ref, project_id, seq, title, body, status, priority, assignee,
            due_at, snooze_until, recur, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref,
        project.id,
        seq,
        title,
        input.body ?? '',
        input.status ?? 'backlog',
        input.priority ?? 2,
        input.assignee ?? null,
        input.dueAt ? input.dueAt.toISOString() : null,
        input.snoozeUntil ? input.snoozeUntil.toISOString() : null,
        input.recur ?? null,
        ts,
        ts,
      );

    const id = Number(info.lastInsertRowid);
    for (const tag of input.tags ?? []) attachTag(db, id, tag);
    for (const blocker of blockers) addDep(db, id, blocker.id, 'blocks');

    logEvent(db, id, input.actor, 'created', null, title);
    return getTaskById(db, id)!;
  });
}

// ---------------------------------------------------------------- tags

export function attachTag(db: Db, taskId: number, name: string): void {
  const tag = name.trim().toLowerCase();
  if (!tag) return;
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
  const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number };
  db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(
    taskId,
    row.id,
  );
}

export function detachTag(db: Db, taskId: number, name: string): void {
  db.prepare(
    'DELETE FROM task_tags WHERE task_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)',
  ).run(taskId, name.trim().toLowerCase());
}

export function listTags(db: Db): { name: string; count: number }[] {
  return db
    .prepare(
      `SELECT tg.name AS name, COUNT(tt.task_id) AS count
       FROM tags tg LEFT JOIN task_tags tt ON tt.tag_id = tg.id
       GROUP BY tg.id HAVING count > 0 ORDER BY count DESC, name`,
    )
    .all() as unknown as { name: string; count: number }[];
}

// ---------------------------------------------------------------- deps

export function addDep(db: Db, taskId: number, dependsOnId: number, kind: DepKind): void {
  if (!DEP_KINDS.includes(kind)) {
    throw new Error(`Unknown dependency kind "${kind}". Valid: ${DEP_KINDS.join(', ')}.`);
  }
  if (taskId === dependsOnId) throw new Error('A task cannot depend on itself.');
  if (kind === 'blocks' && wouldCycle(db, taskId, dependsOnId)) {
    throw new Error(
      'That dependency would create a cycle, which would leave both tasks permanently blocked.',
    );
  }
  db.prepare(
    'INSERT OR IGNORE INTO deps (task_id, depends_on_id, kind) VALUES (?, ?, ?)',
  ).run(taskId, dependsOnId, kind);
}

export function removeDep(db: Db, taskId: number, dependsOnId: number, kind: DepKind): void {
  db.prepare('DELETE FROM deps WHERE task_id = ? AND depends_on_id = ? AND kind = ?').run(
    taskId,
    dependsOnId,
    kind,
  );
}

/** True if `taskId` is already reachable from `dependsOnId` through `blocks` edges. */
function wouldCycle(db: Db, taskId: number, dependsOnId: number): boolean {
  const stmt = db.prepare(
    "SELECT depends_on_id FROM deps WHERE task_id = ? AND kind = 'blocks'",
  );
  const seen = new Set<number>();
  const stack = [dependsOnId];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const row of stmt.all(current) as unknown as { depends_on_id: number }[]) {
      stack.push(row.depends_on_id);
    }
  }
  return false;
}

// ---------------------------------------------------------------- queue

export type QueueOptions = { project?: string; limit?: number; tag?: string };

export function readyTasks(db: Db, opts: QueueOptions = {}): TaskView[] {
  const now = nowIso();
  const params: unknown[] = [now, now, now];
  let where = CLAIMABLE;

  if (opts.project) {
    where += ' AND t.project_id = ?';
    params.push(requireProject(db, opts.project).id);
  }
  if (opts.tag) {
    where += ` AND EXISTS (SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
                           WHERE tt.task_id = t.id AND tg.name = ?)`;
    params.push(opts.tag.trim().toLowerCase());
  }

  params.push(now);
  let sql = `${SELECT_VIEW} WHERE ${where} ${QUEUE_ORDER}`;
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Math.floor(opts.limit)}`;

  return (db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(
    toView,
  );
}

export const DEFAULT_LEASE_MS = 60 * 60 * 1000;

/**
 * Atomically take a task. The full claimability predicate lives in the UPDATE's
 * WHERE clause, so two agents racing on the same task cannot both win: SQLite
 * serialises the writes and the loser sees `changes === 0`.
 *
 * Returns null when the task was taken by someone else, became blocked, or is
 * no longer in a claimable status.
 */
export function claimTask(
  db: Db,
  taskId: number,
  agent: string,
  leaseMs = DEFAULT_LEASE_MS,
): TaskView | null {
  return tx(db, () => {
    const now = nowIso();
    const lease = new Date(Date.now() + leaseMs).toISOString();
    const info = db
      .prepare(
        `UPDATE tasks AS t
            SET assignee = ?, status = 'in_progress', lease_expires_at = ?, updated_at = ?
          WHERE t.id = ? AND ${CLAIMABLE}`,
      )
      .run(agent, lease, now, taskId, now, now, now);

    if (info.changes === 0) return null;
    logEvent(db, taskId, agent, 'claimed', null, agent);
    return getTaskById(db, taskId);
  });
}

/**
 * Take the highest-priority claimable task. Walks the queue rather than
 * claiming blindly: if another agent wins the race for the top item, this moves
 * on to the next instead of failing.
 */
export function claimNext(
  db: Db,
  agent: string,
  opts: QueueOptions & { leaseMs?: number } = {},
): TaskView | null {
  for (const candidate of readyTasks(db, { ...opts, limit: opts.limit ?? 25 })) {
    const claimed = claimTask(db, candidate.id, agent, opts.leaseMs ?? DEFAULT_LEASE_MS);
    if (claimed) return claimed;
  }
  return null;
}

export function releaseTask(db: Db, taskId: number, actor: string): TaskView {
  return tx(db, () => {
    const before = getTaskById(db, taskId)!;
    db.prepare(
      `UPDATE tasks SET assignee = NULL, lease_expires_at = NULL,
              status = CASE WHEN status = 'in_progress' THEN 'ready' ELSE status END,
              updated_at = ? WHERE id = ?`,
    ).run(nowIso(), taskId);
    logEvent(db, taskId, actor, 'released', before.assignee, null);
    return getTaskById(db, taskId)!;
  });
}

// ---------------------------------------------------------------- mutation

export type UpdateInput = {
  title?: string;
  body?: string;
  priority?: number;
  assignee?: string | null;
  dueAt?: Date | null;
  snoozeUntil?: Date | null;
  recur?: string | null;
  project?: string;
};

const UPDATE_COLUMNS: Record<keyof UpdateInput, string> = {
  title: 'title',
  body: 'body',
  priority: 'priority',
  assignee: 'assignee',
  dueAt: 'due_at',
  snoozeUntil: 'snooze_until',
  recur: 'recur',
  project: 'project_id',
};

export function updateTask(
  db: Db,
  taskId: number,
  input: UpdateInput,
  actor: string,
): TaskView {
  return tx(db, () => {
    const before = getTaskById(db, taskId);
    if (!before) throw new Error(`No task with id ${taskId}.`);

    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, column] of Object.entries(UPDATE_COLUMNS) as [
      keyof UpdateInput,
      string,
    ][]) {
      const value = input[key];
      if (value === undefined) continue;

      let next: unknown;
      if (key === 'project') {
        next = requireProject(db, value as string).id;
      } else if (value instanceof Date) {
        next = value.toISOString();
      } else {
        next = value;
      }

      const previous = (before as unknown as Record<string, unknown>)[column];
      if (previous === next) continue;
      sets.push(`${column} = ?`);
      params.push(next);
      logEvent(db, taskId, actor, column, previous, next);
    }

    if (sets.length) {
      params.push(nowIso(), taskId);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...(params as never[]),
      );
    }
    return getTaskById(db, taskId)!;
  });
}

/**
 * Move a task to a new status. Closing a recurring task materialises its next
 * instance, so recurrence needs nothing to be running at the moment it fires —
 * the next occurrence is created the moment the current one is finished.
 */
export function setStatus(
  db: Db,
  taskId: number,
  status: Status,
  actor: string,
): { task: TaskView; recurrence: TaskView | null } {
  if (!STATUSES.includes(status)) {
    throw new Error(`Unknown status "${status}". Valid: ${STATUSES.join(', ')}.`);
  }

  return tx(db, () => {
    const before = getTaskById(db, taskId);
    if (!before) throw new Error(`No task with id ${taskId}.`);

    const closing = CLOSED_STATUSES.includes(status);
    const wasClosed = CLOSED_STATUSES.includes(before.status);
    const ts = nowIso();

    db.prepare(
      `UPDATE tasks
          SET status = ?, closed_at = ?, updated_at = ?,
              lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
        WHERE id = ?`,
    ).run(status, closing ? (before.closed_at ?? ts) : null, ts, closing ? 1 : 0, taskId);

    if (before.status !== status) logEvent(db, taskId, actor, 'status', before.status, status);

    let recurrence: TaskView | null = null;
    if (closing && !wasClosed && before.recur) {
      recurrence = materializeRecurrence(db, before, actor);
    }
    return { task: getTaskById(db, taskId)!, recurrence };
  });
}

/**
 * Create the next occurrence of a recurring task. `snooze_until` is set to the
 * due date so the new instance stays out of the ready queue until its window
 * actually opens.
 */
function materializeRecurrence(db: Db, closed: TaskView, actor: string): TaskView {
  const next = nextCronFire(closed.recur!, new Date());
  const project = db
    .prepare('SELECT key FROM projects WHERE id = ?')
    .get(closed.project_id) as { key: string };

  const created = createTask(db, {
    title: closed.title,
    project: project.key,
    body: closed.body,
    priority: closed.priority,
    status: 'ready',
    dueAt: next,
    snoozeUntil: next,
    recur: closed.recur,
    tags: closed.tags,
    actor,
  });

  db.prepare('UPDATE tasks SET recurs_from = ? WHERE id = ?').run(closed.id, created.id);
  db.prepare('UPDATE tasks SET recur = NULL WHERE id = ?').run(closed.id);
  logEvent(db, created.id, actor, 'recurred_from', closed.ref, created.ref);
  return getTaskById(db, created.id)!;
}

export function deleteTask(db: Db, taskId: number, actor: string): void {
  const task = getTaskById(db, taskId);
  if (!task) throw new Error(`No task with id ${taskId}.`);
  logEvent(db, null, actor, 'deleted', task.ref, task.title);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

// ---------------------------------------------------------------- listing

export type ListFilter = {
  project?: string;
  status?: Status[];
  tag?: string;
  assignee?: string;
  /** Only tasks due on or before this time. */
  dueBefore?: string;
  search?: string;
  includeClosed?: boolean;
  limit?: number;
};

export function listTasks(db: Db, filter: ListFilter = {}): TaskView[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.project) {
    clauses.push('t.project_id = ?');
    params.push(requireProject(db, filter.project).id);
  }
  if (filter.status?.length) {
    clauses.push(`t.status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  } else if (!filter.includeClosed) {
    clauses.push(`t.status NOT IN (${CLOSED_LIST})`);
  }
  if (filter.tag) {
    clauses.push(`EXISTS (SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
                          WHERE tt.task_id = t.id AND tg.name = ?)`);
    params.push(filter.tag.trim().toLowerCase());
  }
  if (filter.assignee) {
    clauses.push('t.assignee = ?');
    params.push(filter.assignee);
  }
  if (filter.dueBefore) {
    clauses.push('t.due_at IS NOT NULL AND t.due_at <= ?');
    params.push(filter.dueBefore);
  }
  if (filter.search) {
    clauses.push('(t.title LIKE ? OR t.body LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(nowIso());
  let sql = `${SELECT_VIEW} ${where} ${QUEUE_ORDER}`;
  if (filter.limit && filter.limit > 0) sql += ` LIMIT ${Math.floor(filter.limit)}`;

  return (db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(
    toView,
  );
}

/** Tasks held by an agent whose lease has lapsed — probably a crashed run. */
export function staleLeases(db: Db): TaskView[] {
  const now = nowIso();
  return (
    db
      .prepare(
        `${SELECT_VIEW} WHERE t.status = 'in_progress'
           AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at <= ?
         ORDER BY t.lease_expires_at`,
      )
      .all(now) as Record<string, unknown>[]
  ).map(toView);
}
