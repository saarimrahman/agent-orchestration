export const STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'needs_input',
  'review',
  'done',
  'cancelled',
] as const;

export type Status = (typeof STATUSES)[number];

/**
 * An agent has asked a question and cannot continue until a human answers.
 * Unlike `blocked`, this is not derivable from anything — the agent has to
 * assert it — which is why it is a real status rather than a computed one.
 */
export const NEEDS_INPUT: Status = 'needs_input';

/** Statuses that mean a task no longer blocks anything downstream. */
export const CLOSED_STATUSES: Status[] = ['done', 'cancelled'];

/** Statuses a task can be in and still be picked up off the queue. */
export const OPEN_QUEUE_STATUSES: Status[] = ['backlog', 'ready'];

export const DEP_KINDS = ['blocks', 'relates', 'parent'] as const;
export type DepKind = (typeof DEP_KINDS)[number];

export const COMMENT_KINDS = ['note', 'progress', 'question', 'answer', 'system'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3'] as const;

export type Project = {
  id: number;
  key: string;
  name: string;
  color: string;
  archived_at: string | null;
  created_at: string;
};

export type Task = {
  id: number;
  ref: string;
  project_id: number;
  seq: number;
  title: string;
  body: string;
  status: Status;
  priority: number;
  assignee: string | null;
  lease_expires_at: string | null;
  due_at: string | null;
  snooze_until: string | null;
  recur: string | null;
  recurs_from: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

/** A task joined with the context callers almost always need alongside it. */
export type TaskView = Task & {
  project_key: string;
  project_name: string;
  project_color: string;
  tags: string[];
  /** Open `blocks` dependencies. Non-empty means the task is blocked. */
  blocked_by: string[];
  /** Tasks whose `blocks` dependency points at this one. */
  blocks: string[];
  comment_count: number;
  /** The outstanding question, when the task is waiting on a human. */
  question: string | null;
  /** Who asked it. */
  question_from: string | null;
};

export type Comment = {
  id: number;
  task_id: number;
  author: string;
  kind: CommentKind;
  body: string;
  created_at: string;
};

export type Event = {
  id: number;
  task_id: number | null;
  actor: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  at: string;
};

export type EventView = Event & {
  task_ref: string | null;
  task_title: string | null;
};
