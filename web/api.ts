import { useCallback, useEffect, useRef, useState } from 'react';

export type Status =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'needs_input'
  | 'review'
  | 'done'
  | 'cancelled';

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
  question: string | null;
  question_from: string | null;
};

export type Comment = {
  id: number;
  task_id: number;
  author: string;
  kind: 'note' | 'progress' | 'question' | 'answer' | 'system';
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
  needs_input: string[];
  stale_leases: string[];
  events: Event[];
  marker: number;
};

export type TaskDetail = Task & { comments: Comment[]; events: Event[] };

export type MemoryDocument = {
  id: string;
  project_id: number | null;
  project_key: string | null;
  scope: 'global' | 'project';
  kind: 'fact' | 'decision' | 'pitfall' | 'playbook' | 'preference' | 'note';
  status: 'candidate' | 'active' | 'superseded' | 'archived';
  title: string;
  path: string;
  aliases: string[];
  tags: string[];
  sources: string[];
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  review_after: string | null;
  relations: MemoryRelation[];
  supersedes: string | null;
  extra_frontmatter: Record<string, unknown>;
  content_hash: string;
  score?: number;
  snippet?: string;
  reasons?: string[];
  explanation?: string;
};

export type MemoryRelationType =
  | 'relates'
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'derived_from'
  | 'applies_to';

export type MemoryTargetType = 'memory' | 'task' | 'comment' | 'file' | 'url';

export type MemoryRelation = {
  type: MemoryRelationType;
  target_type: MemoryTargetType;
  target: string;
};

export type MemoryBacklink = MemoryRelation & {
  source_id: string;
  source: MemoryDocument;
};

export type MemoryConnections = {
  memory: MemoryDocument;
  outgoing: MemoryRelation[];
  backlinks: MemoryBacklink[];
};

export type MemoryGraph = {
  memories: MemoryDocument[];
  relations: (MemoryRelation & { source_id: string })[];
  truncated: boolean;
};

export type MemoryLintIssue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  memory_id: string;
  relation?: MemoryRelation;
};

export type MemorySearchOptions = {
  all?: boolean;
  kind?: MemoryDocument['kind'];
  status?: MemoryDocument['status'];
  tag?: string;
  source?: string;
  verified?: boolean;
  semantic?: boolean;
  graphDepth?: number;
};

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
  memories: (query = '', project?: string | null, options: MemorySearchOptions = {}) => {
    const normalized = query.trim();
    if (!normalized) return request<MemoryDocument[]>('/memories');
    const params = new URLSearchParams({ q: normalized });
    if (project) params.set('project', project);
    if (options.all) params.set('all', '1');
    if (options.kind) params.set('kind', options.kind);
    if (options.status) params.set('status', options.status);
    if (options.tag) params.set('tag', options.tag);
    if (options.source) params.set('source', options.source);
    if (options.verified) params.set('verified', '1');
    if (options.semantic) params.set('semantic', '1');
    if (options.graphDepth) params.set('graph_depth', String(options.graphDepth));
    return request<MemoryDocument[]>(`/memories/search?${params}`);
  },
  memoryConnections: (id: string) =>
    request<MemoryConnections>(`/memories/${encodeURIComponent(id)}/connections`),
  memoryBacklinks: (id: string) =>
    request<MemoryBacklink[]>(`/memories/${encodeURIComponent(id)}/backlinks`),
  memoryGraph: (id?: string, depth = 2, limit = 16) => {
    const params = new URLSearchParams({ depth: String(depth), limit: String(limit) });
    if (id) params.set('id', id);
    return request<MemoryGraph>(`/memories/graph?${params}`);
  },
  memoryLint: () => request<MemoryLintIssue[]>('/memories/lint'),
  linkMemory: (id: string, relation: MemoryRelation) =>
    request<MemoryDocument>(`/memories/${encodeURIComponent(id)}/relations`, {
      method: 'POST', body: body(relation),
    }),
  unlinkMemory: (id: string, relation: MemoryRelation) =>
    request<MemoryDocument>(`/memories/${encodeURIComponent(id)}/relations`, {
      method: 'DELETE', body: body(relation),
    }),
  updateMemory: (id: string, input: Record<string, unknown>) =>
    request<MemoryDocument>(`/memories/${id}`, { method: 'PATCH', body: body(input) }),
  deleteMemory: (id: string) =>
    request<{ deleted: string }>(`/memories/${id}`, { method: 'DELETE' }),
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
  ask: (ref: string, text: string) =>
    request<Task>(`/tasks/${ref}/ask`, { method: 'POST', body: body({ body: text, actor: 'you' }) }),
  answer: (ref: string, text: string) =>
    request<Task>(`/tasks/${ref}/answer`, { method: 'POST', body: body({ body: text, actor: 'you' }) }),
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
  { status: 'needs_input', label: 'Needs you', color: 'var(--color-status-input)' },
  { status: 'review', label: 'Review', color: 'var(--color-status-review)' },
  { status: 'done', label: 'Done', color: 'var(--color-status-done)' },
];

export function needsInput(task: Task): boolean {
  return task.status === 'needs_input';
}
