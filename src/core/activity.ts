import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { logEvent, listTasks, readyTasks, staleLeases } from './tasks.ts';
import { endOfLocalDay } from './time.ts';
import type { Comment, CommentKind, EventView, TaskView } from './types.ts';
import { COMMENT_KINDS } from './types.ts';

export function addComment(
  db: Db,
  taskId: number,
  author: string,
  body: string,
  kind: CommentKind = 'note',
): Comment {
  const text = body.trim();
  if (!text) throw new Error('A comment needs a body.');
  if (!COMMENT_KINDS.includes(kind)) {
    throw new Error(`Unknown comment kind "${kind}". Valid: ${COMMENT_KINDS.join(', ')}.`);
  }

  const info = db
    .prepare(
      'INSERT INTO comments (task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(taskId, author, kind, text, nowIso());

  // Also an event, so comments show up in the activity feed alongside status changes.
  logEvent(db, taskId, author, kind === 'progress' ? 'progress' : 'comment', null, text);

  return db
    .prepare('SELECT * FROM comments WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as Comment;
}

export function listComments(db: Db, taskId: number): Comment[] {
  return db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id')
    .all(taskId) as unknown as Comment[];
}

export function listEvents(db: Db, taskId: number): EventView[] {
  return db
    .prepare(
      `SELECT e.*, t.ref AS task_ref, t.title AS task_title
       FROM events e LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id = ? ORDER BY e.at, e.id`,
    )
    .all(taskId) as unknown as EventView[];
}

/** The global reverse-chronological activity stream that drives the UI feed. */
export function recentEvents(db: Db, limit = 100): EventView[] {
  return db
    .prepare(
      `SELECT e.*, t.ref AS task_ref, t.title AS task_title
       FROM events e LEFT JOIN tasks t ON t.id = e.task_id
       ORDER BY e.id DESC LIMIT ?`,
    )
    .all(Math.floor(limit)) as unknown as EventView[];
}

/** Monotonic change marker. The UI server polls this to decide when to push SSE. */
export function changeMarker(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get() as {
    n: number;
  };
  return row.n;
}

export type Digest = {
  generated_at: string;
  overdue: TaskView[];
  due_today: TaskView[];
  ready: TaskView[];
  in_progress: TaskView[];
  stale_leases: TaskView[];
};

/**
 * The triage payload. Designed to be piped straight into an agent prompt —
 * `claude -p "$(orch digest --json) — triage these"` — which is how scheduling
 * works without this project running any daemon of its own.
 */
export function digest(db: Db, project?: string): Digest {
  const now = nowIso();
  const dueToday = listTasks(db, { project, dueBefore: endOfLocalDay() });

  return {
    generated_at: now,
    overdue: dueToday.filter((t) => t.due_at !== null && t.due_at <= now),
    due_today: dueToday.filter((t) => t.due_at !== null && t.due_at > now),
    ready: readyTasks(db, { project, limit: 20 }),
    in_progress: listTasks(db, { project, status: ['in_progress'] }),
    stale_leases: staleLeases(db),
  };
}
