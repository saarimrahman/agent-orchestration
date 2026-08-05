import { useMemo, useState } from 'react';

import {
  api,
  isOverdue,
  isSnoozed,
  useLiveState,
  type Status,
  type Task,
} from './api.ts';
import { ActivityFeed } from './ActivityFeed.tsx';
import { Board } from './Board.tsx';
import { NewTask } from './NewTask.tsx';
import { TaskDrawer } from './TaskDrawer.tsx';

type ViewId =
  | 'board'
  | 'needs_input'
  | 'today'
  | 'overdue'
  | 'ready'
  | 'mine'
  | 'snoozed'
  | 'done';

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'board', label: 'All open' },
  { id: 'needs_input', label: 'Needs you' },
  { id: 'today', label: 'Due today' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'ready', label: 'Ready' },
  { id: 'mine', label: 'In progress' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Recently done' },
];

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function App() {
  const { state, error, refresh } = useLiveState();
  const [view, setView] = useState<ViewId>('board');
  const [project, setProject] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showFeed, setShowFeed] = useState(true);
  const [composing, setComposing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const readySet = useMemo(() => new Set(state?.ready ?? []), [state?.ready]);

  const tasks = useMemo(() => {
    if (!state) return [];
    const pool = view === 'done' ? state.recently_closed : state.tasks;

    return pool.filter((task) => {
      if (project && task.project_key !== project) return false;
      if (tag && !task.tags.includes(tag)) return false;
      if (query) {
        const haystack = `${task.ref} ${task.title} ${task.body}`.toLowerCase();
        if (!haystack.includes(query.toLowerCase())) return false;
      }
      switch (view) {
        case 'needs_input':
          return task.status === 'needs_input';
        case 'today':
          return task.due_at !== null && new Date(task.due_at).getTime() <= endOfToday();
        case 'overdue':
          return isOverdue(task);
        case 'ready':
          return readySet.has(task.ref);
        case 'mine':
          return task.status === 'in_progress';
        case 'snoozed':
          return isSnoozed(task);
        default:
          return true;
      }
    });
  }, [state, view, project, tag, query, readySet]);

  const move = async (ref: string, status: Status) => {
    try {
      await api.patch(ref, { status });
      await refresh();
      setActionError(null);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const counts = useMemo(() => {
    if (!state) return { needsInput: 0, overdue: 0, ready: 0, progress: 0, stale: 0 };
    return {
      needsInput: state.needs_input.length,
      overdue: state.tasks.filter(isOverdue).length,
      ready: state.ready.length,
      progress: state.tasks.filter((t) => t.status === 'in_progress').length,
      stale: state.stale_leases.length,
    };
  }, [state]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-ink-500">
        {error ?? 'Loading…'}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <nav className="flex w-[196px] shrink-0 flex-col gap-5 border-r border-ink-850 bg-ink-900 px-3 py-4">
        <div className="flex items-center gap-2 px-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-ink-50">orch</span>
        </div>

        <button
          onClick={() => setComposing(true)}
          className="rounded-md bg-accent/15 py-1.5 text-[12px] font-medium text-accent
                     transition-colors hover:bg-accent/25"
        >
          + New task
        </button>

        <Section title="Views">
          {VIEWS.map((v) => (
            <SidebarButton
              key={v.id}
              active={view === v.id}
              onClick={() => setView(v.id)}
              badge={
                v.id === 'needs_input'
                  ? counts.needsInput
                  : v.id === 'overdue'
                    ? counts.overdue
                  : v.id === 'ready'
                    ? counts.ready
                      : v.id === 'mine'
                        ? counts.progress
                        : undefined
              }
              danger={v.id === 'overdue'}
              attention={v.id === 'needs_input'}
            >
              {v.label}
            </SidebarButton>
          ))}
        </Section>

        <Section title="Projects">
          <SidebarButton active={project === null} onClick={() => setProject(null)}>
            All
          </SidebarButton>
          {state.projects
            .filter((p) => !p.archived_at)
            .map((p) => (
              <SidebarButton
                key={p.key}
                active={project === p.key}
                onClick={() => setProject(project === p.key ? null : p.key)}
                dot={p.color}
              >
                {p.name}
              </SidebarButton>
            ))}
        </Section>

        {state.tags.length > 0 && (
          <Section title="Tags">
            <div className="flex flex-wrap gap-1 px-1">
              {state.tags.slice(0, 18).map((t) => (
                <button
                  key={t.name}
                  onClick={() => setTag(tag === t.name ? null : t.name)}
                  className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                    tag === t.name
                      ? 'bg-accent/20 text-accent'
                      : 'bg-ink-850 text-ink-400 hover:bg-ink-800'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </Section>
        )}

        {counts.stale > 0 && (
          <div className="mt-auto rounded-md border border-p1/25 bg-p1/8 px-2.5 py-2">
            <p className="text-[11px] leading-snug text-p1">
              {counts.stale} task{counts.stale > 1 ? 's' : ''} held by an agent past its lease.
              They are claimable again.
            </p>
          </div>
        )}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 px-4 py-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-64 rounded-md border border-ink-850 bg-ink-900 px-2.5 py-1.5 text-[13px]
                       text-ink-50 outline-none transition-colors placeholder:text-ink-600
                       focus:border-accent-dim"
          />
          <span className="text-[12px] text-ink-600">
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
            {project && ` in ${project}`}
            {tag && ` tagged ${tag}`}
          </span>
          {actionError && (
            <span className="rounded bg-p0/12 px-2 py-1 text-[12px] text-p0">{actionError}</span>
          )}
          <button
            onClick={() => setShowFeed(!showFeed)}
            className={`ml-auto rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
              showFeed
                ? 'border-ink-700 bg-ink-850 text-ink-200'
                : 'border-ink-850 text-ink-500 hover:bg-ink-850'
            }`}
          >
            Activity
          </button>
        </header>

        {counts.needsInput > 0 && view !== 'needs_input' && (
          <button
            onClick={() => setView('needs_input')}
            className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-status-input/30
                       bg-status-input/8 px-3 py-2 text-left transition-colors
                       hover:bg-status-input/14"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-input" />
            <span className="text-[12.5px] text-ink-100">
              {counts.needsInput} task{counts.needsInput > 1 ? 's are' : ' is'} waiting on your
              answer
            </span>
            <span className="ml-auto text-[11px] text-status-input">Review →</span>
          </button>
        )}

        <div className="min-h-0 flex-1">
          <Board tasks={tasks} onOpen={setSelected} onMove={move} />
        </div>
      </main>

      {selected && (
        <TaskDrawer
          taskRef={selected}
          projects={state.projects.filter((p) => !p.archived_at)}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}

      {showFeed && !selected && <ActivityFeed events={state.events} onOpen={setSelected} />}

      {composing && (
        <NewTask
          projects={state.projects.filter((p) => !p.archived_at)}
          defaultProject={project ?? state.projects[0]?.key}
          onClose={() => setComposing(false)}
          onCreated={async (ref) => {
            setComposing(false);
            await refresh();
            setSelected(ref);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 px-1 text-[10px] font-medium tracking-wider text-ink-600 uppercase">
        {title}
      </p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function SidebarButton({
  active,
  onClick,
  children,
  badge,
  dot,
  danger,
  attention,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  dot?: string;
  danger?: boolean;
  attention?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px]
                  transition-colors ${
                    active ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-850'
                  }`}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
      <span className="truncate">{children}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={`ml-auto text-[11px] ${
            attention
              ? 'rounded bg-status-input/18 px-1.5 font-medium text-status-input'
              : danger
                ? 'text-p0'
                : 'text-ink-600'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export type { Task };
