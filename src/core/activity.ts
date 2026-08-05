import type { Db } from './db.ts';
import { nowIso, tx } from './db.ts';
import { getTaskById, logEvent, listTasks, readyTasks, staleLeases } from './tasks.ts';
import { endOfLocalDay } from './time.ts';
import type { Comment, CommentKind, EventView, TaskView } from './types.ts';
import { CLOSED_STATUSES, COMMENT_KINDS } from './types.ts';

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

  // Also an event, so comments show up in the activity feed alongside status
  // changes. Questions and answers get their own field so the feed can call
  // them out rather than burying them among ordinary notes.
  const field = kind === 'note' || kind === 'system' ? 'comment' : kind;
  logEvent(db, taskId, author, field, null, text);

  return db
    .prepare('SELECT * FROM comments WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as Comment;
}

/**
 * Hand a task back to a human with a question. The lease is dropped so the task
 * is not counted as work in flight, and the status change keeps it out of the
 * ready queue until somebody answers — an agent polling `orchestration next` will not
 * pick up a question it cannot answer itself.
 */
export function askForInput(
  db: Db,
  taskId: number,
  actor: string,
  question: string,
): { task: TaskView; comment: Comment } {
  const text = question.trim();
  if (!text) throw new Error('What do you need to know? Give the question a body.');

  return tx(db, () => {
    const before = getTaskById(db, taskId);
    if (!before) throw new Error(`No task with id ${taskId}.`);
    if (CLOSED_STATUSES.includes(before.status)) {
      throw new Error(
        `${before.ref} is already ${before.status}. Reopen it before asking a question.`,
      );
    }

    const comment = addComment(db, taskId, actor, text, 'question');
    db.prepare(
      `UPDATE tasks SET status = 'needs_input', assignee = NULL, lease_expires_at = NULL,
              updated_at = ? WHERE id = ?`,
    ).run(nowIso(), taskId);
    logEvent(db, taskId, actor, 'status', before.status, 'needs_input');

    return { task: getTaskById(db, taskId)!, comment };
  });
}

/**
 * Answer an outstanding question and put the task back on the queue. It returns
 * to `ready` rather than to whoever asked: by the time a human replies, that
 * agent's session is usually long gone, and the answer is in the thread for
 * whichever agent picks it up next.
 */
export function answerInput(
  db: Db,
  taskId: number,
  actor: string,
  answer: string,
): { task: TaskView; comment: Comment } {
  const text = answer.trim();
  if (!text) throw new Error('An answer needs a body.');

  return tx(db, () => {
    const before = getTaskById(db, taskId);
    if (!before) throw new Error(`No task with id ${taskId}.`);

    const comment = addComment(db, taskId, actor, text, 'answer');
    if (before.status === 'needs_input') {
      db.prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?").run(
        nowIso(),
        taskId,
      );
      logEvent(db, taskId, actor, 'status', 'needs_input', 'ready');
    }
    return { task: getTaskById(db, taskId)!, comment };
  });
}

/** Everything currently waiting on a human, oldest question first. */
export function awaitingInput(db: Db, project?: string): TaskView[] {
  return listTasks(db, { project, status: ['needs_input'] });
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
  /** Questions from agents. Listed first because only a human can clear these. */
  needs_input: TaskView[];
  overdue: TaskView[];
  due_today: TaskView[];
  ready: TaskView[];
  in_progress: TaskView[];
  stale_leases: TaskView[];
};

/**
 * The triage payload. Designed to be piped straight into an agent prompt —
 * `claude -p "$(orchestration digest --json) — triage these"` — which is how scheduling
 * works without this project running any daemon of its own.
 */
export function digest(db: Db, project?: string): Digest {
  const now = nowIso();
  const dueToday = listTasks(db, { project, dueBefore: endOfLocalDay() });

  return {
    generated_at: now,
    needs_input: awaitingInput(db, project),
    overdue: dueToday.filter((t) => t.due_at !== null && t.due_at <= now),
    due_today: dueToday.filter((t) => t.due_at !== null && t.due_at > now),
    ready: readyTasks(db, { project, limit: 20 }),
    in_progress: listTasks(db, { project, status: ['in_progress'] }),
    stale_leases: staleLeases(db),
  };
}
