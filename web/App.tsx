import {
  Archive,
  BellRing,
  CalendarDays,
  CheckCircle2,
  CircleDotDashed,
  Clock3,
  Database,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Menu,
  MessageSquareWarning,
  PanelRight,
  Plus,
  Search,
  Sparkles,
  Tag,
  TimerReset,
  UserRoundCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ActivityFeed } from './ActivityFeed.tsx';
import { Board } from './Board.tsx';
import { Button } from './components/ui/button.tsx';
import { cn } from './lib/utils.ts';
import { MemoryView } from './MemoryView.tsx';
import { NewTask } from './NewTask.tsx';
import { TaskDrawer } from './TaskDrawer.tsx';
import {
  api,
  isOverdue,
  isSnoozed,
  useLiveState,
  type Status,
  type Task,
} from './api.ts';

type ViewId =
  | 'board'
  | 'needs_input'
  | 'today'
  | 'overdue'
  | 'ready'
  | 'mine'
  | 'snoozed'
  | 'done'
  | 'memory';

type View = { id: ViewId; label: string; description: string; icon: LucideIcon };

const VIEWS: View[] = [
  { id: 'board', label: 'All open', description: 'Everything currently in flight', icon: LayoutDashboard },
  { id: 'needs_input', label: 'Needs you', description: 'Decisions waiting on you', icon: MessageSquareWarning },
  { id: 'today', label: 'Due today', description: 'Work due before day’s end', icon: CalendarDays },
  { id: 'overdue', label: 'Overdue', description: 'Tasks past their due date', icon: Clock3 },
  { id: 'ready', label: 'Ready', description: 'Unblocked and ready to claim', icon: CircleDotDashed },
  { id: 'mine', label: 'In progress', description: 'Tasks currently being worked', icon: UserRoundCheck },
  { id: 'snoozed', label: 'Snoozed', description: 'Work deferred until later', icon: TimerReset },
  { id: 'done', label: 'Recently done', description: 'Your latest completed work', icon: CheckCircle2 },
  { id: 'memory', label: 'Memory', description: 'Durable project knowledge', icon: Database },
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
  const [showFeed, setShowFeed] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1280px)').matches : true,
  );
  const [composing, setComposing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!isTyping && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setComposing(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const readySet = useMemo(() => new Set(state?.ready ?? []), [state?.ready]);
  const currentView = VIEWS.find((item) => item.id === view) ?? VIEWS[0];

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
      progress: state.tasks.filter((task) => task.status === 'in_progress').length,
      stale: state.stale_leases.length,
    };
  }, [state]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center bg-ink-950">
        <div className="flex flex-col items-center gap-3 text-[13px] text-ink-500">
          <span className="size-5 animate-spin rounded-full border-2 border-ink-700 border-t-accent" />
          {error ?? 'Loading your workspace…'}
        </div>
      </div>
    );
  }

  const chooseView = (next: ViewId) => {
    setView(next);
    setSidebarOpen(false);
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-ink-950">
      <div className="app-grid pointer-events-none absolute inset-0 opacity-35" />

      {sidebarOpen && (
        <button
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="dialog-backdrop fixed inset-0 z-30 bg-black/55 md:hidden"
        />
      )}

      <nav
        className={cn(
          'surface-shadow fixed inset-y-0 left-0 z-40 flex w-[238px] shrink-0 flex-col border-r border-white/[.055] bg-ink-925/95 px-3 py-4 backdrop-blur-xl transition-transform md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-2">
          <span className="relative grid size-8 place-items-center rounded-xl border border-accent/20 bg-accent/10 shadow-[0_0_30px_rgba(124,135,248,.14)]">
            <Sparkles className="size-4 text-accent-soft" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ink-50">Orchestration</p>
            <p className="text-[10px] tracking-wide text-ink-600">AGENT WORKSPACE</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
            className="ml-auto md:hidden"
          >
            <X />
          </Button>
        </div>

        <Button onClick={() => setComposing(true)} className="mt-5 w-full justify-start">
          <Plus />
          New task
          <span className="ml-auto rounded border border-white/10 bg-black/10 px-1.5 py-0.5 text-[9px] font-normal text-white/55">N</span>
        </Button>

        <div className="mt-6 min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
          <Section title="Workspace">
            {VIEWS.map((item) => (
              <SidebarButton
                key={item.id}
                icon={item.icon}
                active={view === item.id}
                onClick={() => chooseView(item.id)}
                badge={
                  item.id === 'needs_input'
                    ? counts.needsInput
                    : item.id === 'overdue'
                      ? counts.overdue
                      : item.id === 'ready'
                        ? counts.ready
                        : item.id === 'mine'
                          ? counts.progress
                          : undefined
                }
                danger={item.id === 'overdue'}
                attention={item.id === 'needs_input'}
              >
                {item.label}
              </SidebarButton>
            ))}
          </Section>

          <Section title="Projects">
            <SidebarButton icon={Inbox} active={project === null} onClick={() => setProject(null)}>
              All projects
            </SidebarButton>
            {state.projects
              .filter((item) => !item.archived_at)
              .map((item) => (
                <SidebarButton
                  key={item.key}
                  active={project === item.key}
                  onClick={() => setProject(project === item.key ? null : item.key)}
                  dot={item.color}
                >
                  {item.name}
                </SidebarButton>
              ))}
          </Section>

          {state.tags.length > 0 && (
            <Section title="Popular tags">
              <div className="flex flex-wrap gap-1.5 px-1">
                {state.tags.slice(0, 12).map((item) => (
                  <button
                    key={item.name}
                    onClick={() => setTag(tag === item.name ? null : item.name)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[10.5px] transition-all',
                      tag === item.name
                        ? 'border-accent/20 bg-accent/12 text-accent-soft'
                        : 'border-white/[.045] bg-white/[.025] text-ink-500 hover:border-white/10 hover:text-ink-300',
                    )}
                  >
                    #{item.name}
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>

        <div className="mt-3 border-t border-white/[.055] pt-3">
          {counts.stale > 0 ? (
            <div className="rounded-lg border border-p1/20 bg-p1/[.07] p-2.5">
              <div className="flex items-center gap-2 text-p1">
                <BellRing className="size-3.5" />
                <span className="text-[11px] font-medium">Expired leases</span>
              </div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-400">
                {counts.stale} task{counts.stale === 1 ? ' is' : 's are'} claimable again.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-2 py-1 text-[10.5px] text-ink-600">
              <span className="size-1.5 rounded-full bg-status-done shadow-[0_0_8px_rgba(104,200,139,.7)]" />
              Live updates connected
            </div>
          )}
        </div>
      </nav>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[72px] items-center gap-3 border-b border-white/[.045] px-3 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} className="md:hidden">
            <Menu />
            <span className="sr-only">Open navigation</span>
          </Button>

          <div className="hidden min-w-[148px] lg:block">
            <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-ink-50">{currentView.label}</h1>
            <p className="mt-0.5 text-[10.5px] text-ink-600">{currentView.description}</p>
          </div>

          <div className="relative min-w-0 flex-1 lg:max-w-[440px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-600" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={view === 'memory' ? 'Search project memory…' : 'Search tasks, refs, or descriptions…'}
              className="h-9 w-full rounded-lg border border-white/[.065] bg-white/[.035] pr-10 pl-9 text-[12.5px] text-ink-50 shadow-sm outline-none transition-all placeholder:text-ink-600 hover:border-white/10 focus:border-accent/45 focus:bg-ink-900 focus:ring-3 focus:ring-accent/10"
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-0.5 text-ink-600 hover:text-ink-300"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-white/[.07] px-1.5 py-0.5 text-[9px] text-ink-600">⌘K</span>
            )}
          </div>

          {view !== 'memory' && (
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-ink-600 sm:inline">
                {tasks.length} task{tasks.length === 1 ? '' : 's'}
              </span>
              <Button
                variant={showFeed ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setShowFeed(!showFeed)}
                aria-pressed={showFeed}
              >
                <PanelRight />
                <span className="hidden sm:inline">Activity</span>
              </Button>
            </div>
          )}
        </header>

        {(project || tag || actionError) && (
          <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-white/[.04] px-4 py-2">
            {project && (
              <FilterChip icon={Archive} onClear={() => setProject(null)}>
                {project}
              </FilterChip>
            )}
            {tag && (
              <FilterChip icon={Tag} onClear={() => setTag(null)}>
                {tag}
              </FilterChip>
            )}
            {actionError && (
              <span className="rounded-md border border-p0/20 bg-p0/10 px-2.5 py-1 text-[11px] text-p0">
                {actionError}
              </span>
            )}
          </div>
        )}

        {counts.needsInput > 0 && view !== 'needs_input' && view !== 'memory' && (
          <button
            onClick={() => setView('needs_input')}
            className="group mx-4 mt-3 flex items-center gap-3 rounded-xl border border-status-input/20 bg-status-input/[.065] px-3.5 py-2.5 text-left shadow-[0_12px_30px_-22px_rgba(240,129,177,.8)] transition-all hover:border-status-input/30 hover:bg-status-input/[.095]"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-status-input/12 text-status-input">
              <MessageSquareWarning className="size-3.5" />
            </span>
            <span className="text-[12px] text-ink-200">
              <strong className="font-medium text-ink-50">{counts.needsInput} task{counts.needsInput > 1 ? 's are' : ' is'}</strong>{' '}
              waiting on your answer
            </span>
            <span className="ml-auto text-[10.5px] font-medium text-status-input transition-transform group-hover:translate-x-0.5">Review →</span>
          </button>
        )}

        {view !== 'memory' && state.tasks.length === 0 && state.recently_closed.length === 0 && (
          <div className="mx-4 mt-3 flex items-center gap-4 rounded-xl border border-accent/20 bg-accent/[.055] px-4 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent-soft">
              <ListTodo className="size-4" />
            </span>
            <div>
              <p className="text-[12.5px] font-medium text-ink-50">Your board is ready</p>
              <p className="mt-0.5 text-[11px] text-ink-500">Create the first task here. Agent and CLI updates will appear live.</p>
            </div>
            <Button size="sm" onClick={() => setComposing(true)} className="ml-auto">
              <Plus /> Create first task
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 pt-3">
          {view === 'memory' ? (
            <MemoryView query={query} project={project} />
          ) : (
            <Board tasks={tasks} onOpen={setSelected} onMove={move} />
          )}
        </div>
      </main>

      {selected && (
        <TaskDrawer
          taskRef={selected}
          projects={state.projects.filter((item) => !item.archived_at)}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}

      {showFeed && !selected && view !== 'memory' && (
        <ActivityFeed events={state.events} onOpen={setSelected} onClose={() => setShowFeed(false)} />
      )}

      {composing && (
        <NewTask
          projects={state.projects.filter((item) => !item.archived_at)}
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
    <section>
      <p className="mb-1.5 px-2 text-[9.5px] font-semibold tracking-[0.13em] text-ink-600 uppercase">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function SidebarButton({
  active,
  onClick,
  children,
  badge,
  dot,
  icon: Icon,
  danger,
  attention,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  dot?: string;
  icon?: LucideIcon;
  danger?: boolean;
  attention?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] outline-none transition-all focus-visible:ring-2 focus-visible:ring-accent/40',
        active
          ? 'bg-white/[.07] text-ink-50 shadow-[0_1px_0_rgba(255,255,255,.035)_inset]'
          : 'text-ink-500 hover:bg-white/[.035] hover:text-ink-300',
      )}
    >
      {Icon ? (
        <Icon className={cn('size-3.5 shrink-0', active ? 'text-accent-soft' : 'text-ink-600 group-hover:text-ink-400')} />
      ) : (
        <span
          className="size-2 shrink-0 rounded-full border border-white/10"
          style={{ background: dot }}
        />
      )}
      <span className="truncate">{children}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'ml-auto min-w-5 rounded-md px-1.5 py-0.5 text-center text-[9.5px] font-semibold',
            attention
              ? 'bg-status-input/15 text-status-input'
              : danger
                ? 'bg-p0/10 text-p0'
                : 'bg-white/[.055] text-ink-500',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function FilterChip({ icon: Icon, children, onClear }: { icon: LucideIcon; children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[.065] bg-white/[.035] py-1 pr-1 pl-2 text-[10.5px] text-ink-400">
      <Icon className="size-3" />
      {children}
      <button onClick={onClear} aria-label="Remove filter" className="rounded p-0.5 hover:bg-white/[.07] hover:text-ink-100">
        <X className="size-3" />
      </button>
    </span>
  );
}

export type { Task };
