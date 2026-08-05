import { useCallback, useEffect, useRef, useState } from 'react';

export type Status = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'cancelled';

export type Task = {
  id: number;
  ref: string;
  project_id: number;
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
  project_key: string;
  project_name: string;
  project_color: string;
  tags: string[];
  blocked_by: string[];
  blocks: string[];
  comment_count: number;
};

export type Comment = {
  id: number;
  task_id: number;
  author: string;
  kind: 'note' | 'progress' | 'system';
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
  task_ref: string | null;
  task_title: string | null;
};

export type Project = {
  id: number;
  key: string;
  name: string;
  color: string;
  archived_at: string | null;
};

export type State = {
  projects: Project[];
  tags: { name: string; count: number }[];
  tasks: Task[];
  recently_closed: Task[];
  ready: string[];
  stale_leases: string[];
  events: Event[];
  marker: number;
};

export type TaskDetail = Task & { comments: Comment[]; events: Event[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  state: () => request<State>('/state'),
  task: (ref: string) => request<TaskDetail>(`/tasks/${ref}`),
  create: (input: Record<string, unknown>) =>
    request<Task>('/tasks', { method: 'POST', body: body(input) }),
  patch: (ref: string, input: Record<string, unknown>) =>
    request<Task>(`/tasks/${ref}`, { method: 'PATCH', body: body(input) }),
  remove: (ref: string) => request<unknown>(`/tasks/${ref}`, { method: 'DELETE' }),
  comment: (ref: string, text: string, kind: 'note' | 'progress' = 'note') =>
    request<Comment>(`/tasks/${ref}/comments`, {
      method: 'POST',
      body: body({ body: text, kind, author: 'you' }),
    }),
  claim: (ref: string, agent = 'you') =>
    request<Task>(`/tasks/${ref}/claim`, { method: 'POST', body: body({ agent }) }),
  release: (ref: string) => request<Task>(`/tasks/${ref}/release`, { method: 'POST' }),
  addDep: (ref: string, blocker: string) =>
    request<Task>(`/tasks/${ref}/deps`, { method: 'POST', body: body({ blocker }) }),
  removeDep: (ref: string, blocker: string) =>
    request<Task>(`/tasks/${ref}/deps/${blocker}`, { method: 'DELETE' }),
  addProject: (key: string, name?: string) =>
    request<Project>('/projects', { method: 'POST', body: body({ key, name }) }),
};

/**
 * Board state, refetched whenever the server reports a change. The SSE stream
 * carries only a marker, not a payload, so a write from any process — the CLI
 * in another terminal included — triggers the same refresh path.
 */
export function useLiveState() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const marker = useRef(-1);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      marker.current = next.marker;
      setState(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const source = new EventSource('/api/stream');
    source.addEventListener('change', (event) => {
      const next = Number((event as MessageEvent).data);
      if (next !== marker.current) void refresh();
    });
    source.onerror = () => {
      /* EventSource reconnects on its own; a dropped stream is not an error worth showing */
    };
    return () => source.close();
  }, [refresh]);

  return { state, error, refresh };
}

// ---------------------------------------------------------------- formatting

export function relativeTime(iso: string, from = Date.now()): string {
  const delta = new Date(iso).getTime() - from;
  const abs = Math.abs(delta);
  if (abs < 60_000) return 'now';

  const units: [number, string][] = [
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return delta < 0 ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return 'now';
}

export function isOverdue(task: Task): boolean {
  return task.due_at !== null && new Date(task.due_at).getTime() <= Date.now();
}

export function isSnoozed(task: Task): boolean {
  return task.snooze_until !== null && new Date(task.snooze_until).getTime() > Date.now();
}

export function leaseExpired(task: Task): boolean {
  return (
    task.status === 'in_progress' &&
    task.lease_expires_at !== null &&
    new Date(task.lease_expires_at).getTime() <= Date.now()
  );
}

export const PRIORITY_COLOR = [
  'var(--color-p0)',
  'var(--color-p1)',
  'var(--color-p2)',
  'var(--color-p3)',
];

export const COLUMNS: { status: Status; label: string; color: string }[] = [
  { status: 'backlog', label: 'Backlog', color: 'var(--color-status-backlog)' },
  { status: 'ready', label: 'Ready', color: 'var(--color-status-ready)' },
  { status: 'in_progress', label: 'In progress', color: 'var(--color-status-progress)' },
  { status: 'review', label: 'Review', color: 'var(--color-status-review)' },
  { status: 'done', label: 'Done', color: 'var(--color-status-done)' },
];
