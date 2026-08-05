import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleHelp,
  MessageCircle,
  X,
} from 'lucide-react';

import { relativeTime, type Event } from './api.ts';
import { PanelResizeHandle, useResizablePanel } from './components/ResizablePanel.tsx';
import { Button } from './components/ui/button.tsx';
import { cn } from './lib/utils.ts';

const STATUS_TEXT: Record<string, string> = {
  backlog: 'text-status-backlog',
  ready: 'text-status-ready',
  in_progress: 'text-status-progress',
  needs_input: 'text-status-input',
  review: 'text-status-review',
  done: 'text-status-done',
  cancelled: 'text-ink-500',
};

function describe(event: Event) {
  const value = event.new_value ?? '';
  switch (event.field) {
    case 'created':
      return <>created this task</>;
    case 'status':
      return <><span>moved it to </span><span className={STATUS_TEXT[value] ?? 'text-ink-200'}>{value.replace(/_/g, ' ')}</span></>;
    case 'claimed':
      return <>claimed this task</>;
    case 'released':
      return <>released this task</>;
    case 'progress':
      return <>reported <span className="text-ink-200">{value}</span></>;
    case 'comment':
      return <>commented <span className="text-ink-200">{value}</span></>;
    case 'question':
      return <><span className="text-status-input">asked</span> <span className="text-ink-200">{value}</span></>;
    case 'answer':
      return <><span className="text-status-done">answered</span> <span className="text-ink-200">{value}</span></>;
    case 'recurred_from':
      return <>rolled over from {event.old_value}</>;
    case 'deleted':
      return <>deleted {event.old_value}</>;
    case 'due_at':
      return <>set the due date</>;
    case 'snooze_until':
      return <>snoozed this task</>;
    case 'priority':
      return <>set priority to <span className="text-ink-200">P{value}</span></>;
    default:
      return <>changed {event.field.replace(/_/g, ' ')}</>;
  }
}

function EventIcon({ event }: { event: Event }) {
  const Icon = event.field === 'question'
    ? CircleHelp
    : event.field === 'answer'
      ? CheckCircle2
      : event.field === 'comment'
        ? MessageCircle
        : event.field === 'claimed' || event.field === 'progress'
          ? Bot
          : ArrowRight;
  const color = event.field === 'question'
    ? 'border-status-input/20 bg-status-input/10 text-status-input'
    : event.field === 'answer'
      ? 'border-status-done/20 bg-status-done/10 text-status-done'
      : event.field === 'claimed' || event.field === 'progress'
        ? 'border-accent/20 bg-accent/10 text-accent-soft'
        : 'border-white/[.055] bg-white/[.035] text-ink-600';

  return (
    <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg border', color)}>
      <Icon className="size-3" />
    </span>
  );
}

export function EventLine({
  event,
  showRef = true,
  onOpen,
}: {
  event: Event;
  showRef?: boolean;
  onOpen?: (ref: string) => void;
}) {
  return (
    <div className="flex gap-2.5 py-1 text-[11px] leading-relaxed">
      <EventIcon event={event} />
      <div className="min-w-0 flex-1">
        <p className="text-ink-500">
          <span className="font-medium text-ink-200">{event.actor}</span>{' '}
          {showRef && event.task_ref && (
            <>
              <button
                onClick={() => onOpen?.(event.task_ref!)}
                className="font-mono text-[10px] text-ink-400 outline-none transition-colors hover:text-accent-soft focus-visible:text-accent-soft"
              >
                {event.task_ref}
              </button>{' '}
            </>
          )}
          {describe(event)}
        </p>
        <p className="mt-0.5 text-[9.5px] text-ink-700">{relativeTime(event.at)}</p>
      </div>
    </div>
  );
}

export function ActivityFeed({
  events,
  onOpen,
  onClose,
}: {
  events: Event[];
  onOpen: (ref: string) => void;
  onClose: () => void;
}) {
  const { panelStyle, handleProps } = useResizablePanel({
    storageKey: 'orchestration.activity-panel-width',
    defaultWidth: 340,
    minWidth: 280,
    maxWidth: 560,
    mobileCap: 360,
  });

  return (
    <>
      <button
        aria-label="Close activity"
        onClick={onClose}
        className="dialog-backdrop fixed inset-0 z-20 bg-black/45 xl:hidden"
      />
      <aside
        style={panelStyle}
        className="resizable-right-panel drawer-panel surface-shadow fixed inset-y-0 right-0 z-30 flex shrink-0 flex-col border-l border-white/[.055] bg-ink-925/97 backdrop-blur-xl xl:relative"
      >
        <PanelResizeHandle {...handleProps} label="Resize activity panel" />
        <header className="flex min-h-[72px] items-center gap-3 border-b border-white/[.055] px-4">
          <span className="grid size-8 place-items-center rounded-xl border border-accent/15 bg-accent/[.08] text-accent-soft">
            <Activity className="size-4" />
          </span>
          <div>
            <h2 className="text-[12.5px] font-semibold text-ink-100">Activity</h2>
            <p className="mt-0.5 text-[10px] text-ink-600">Live updates across your workspace</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto">
            <X />
            <span className="sr-only">Close activity</span>
          </Button>
        </header>
        <div className="flex-1 space-y-1 overflow-y-auto px-4 py-3">
          {events.map((event) => (
            <EventLine key={event.id} event={event} onOpen={onOpen} />
          ))}
          {events.length === 0 && (
            <div className="grid h-40 place-items-center text-center">
              <div>
                <Activity className="mx-auto size-4 text-ink-700" />
                <p className="mt-2 text-[11px] text-ink-600">Nothing has happened yet.</p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
