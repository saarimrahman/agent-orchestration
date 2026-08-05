import { relativeTime, type Event } from './api.ts';

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
      return <>created it</>;
    case 'status':
      return (
        <>
          moved to <span className={STATUS_TEXT[value] ?? 'text-ink-200'}>{value}</span>
        </>
      );
    case 'claimed':
      return <>claimed it</>;
    case 'released':
      return <>released it</>;
    case 'progress':
      return (
        <>
          reported <span className="text-ink-200">{value}</span>
        </>
      );
    case 'comment':
      return (
        <>
          commented <span className="text-ink-200">{value}</span>
        </>
      );
    case 'question':
      return (
        <>
          <span className="text-status-input">asked</span>{' '}
          <span className="text-ink-200">{value}</span>
        </>
      );
    case 'answer':
      return (
        <>
          <span className="text-status-done">answered</span>{' '}
          <span className="text-ink-200">{value}</span>
        </>
      );
    case 'recurred_from':
      return <>rolled over from {event.old_value}</>;
    case 'deleted':
      return <>deleted {event.old_value}</>;
    case 'due_at':
      return <>set the due date</>;
    case 'snooze_until':
      return <>snoozed it</>;
    case 'priority':
      return (
        <>
          set priority to <span className="text-ink-200">P{value}</span>
        </>
      );
    default:
      return <>changed {event.field.replace(/_/g, ' ')}</>;
  }
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
  const isAgentUpdate = event.field === 'progress' || event.field === 'claimed';
  const wantsYou = event.field === 'question';

  return (
    <div className="flex items-baseline gap-2 text-[12px] leading-relaxed">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          wantsYou ? 'bg-status-input' : isAgentUpdate ? 'bg-accent' : 'bg-ink-700'
        }`}
      />
      <span className="min-w-0 flex-1 text-ink-500">
        <span className="font-medium text-ink-100">{event.actor}</span>{' '}
        {showRef && event.task_ref && (
          <>
            <button
              onClick={() => onOpen?.(event.task_ref!)}
              className="font-mono text-ink-400 transition-colors hover:text-accent"
            >
              {event.task_ref}
            </button>{' '}
          </>
        )}
        {describe(event)}
      </span>
      <span className="shrink-0 text-[11px] text-ink-600">{relativeTime(event.at)}</span>
    </div>
  );
}

export function ActivityFeed({
  events,
  onOpen,
}: {
  events: Event[];
  onOpen: (ref: string) => void;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-ink-850 bg-ink-900">
      <header className="border-b border-ink-850 px-4 py-3">
        <h2 className="text-[12px] font-medium tracking-wide text-ink-200 uppercase">Activity</h2>
        <p className="mt-0.5 text-[11px] text-ink-600">
          Everything agents and you have done, newest first
        </p>
      </header>
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {events.map((event) => (
          <EventLine key={event.id} event={event} onOpen={onOpen} />
        ))}
        {events.length === 0 && <p className="text-[12px] text-ink-600">Nothing yet.</p>}
      </div>
    </aside>
  );
}
