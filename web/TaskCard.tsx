import { useDraggable } from '@dnd-kit/core';
import {
  CalendarClock,
  CircleAlert,
  Clock3,
  GripVertical,
  MessageSquare,
  MoonStar,
  Repeat2,
  UserRound,
} from 'lucide-react';

import {
  PRIORITY_COLOR,
  isOverdue,
  isSnoozed,
  leaseExpired,
  relativeTime,
  type Task,
} from './api.ts';
import { Badge } from './components/ui/badge.tsx';
import { cn } from './lib/utils.ts';

type Props = {
  task: Task;
  onOpen: (ref: string) => void;
  dimmed?: boolean;
};

export function TaskCard({ task, onOpen, dimmed }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.ref });

  const blocked = task.blocked_by.length > 0;
  const overdue = isOverdue(task) && task.status !== 'done';
  const snoozed = isSnoozed(task);
  const stale = leaseExpired(task);
  const shownTags = task.tags.slice(0, 3);

  return (
    <article
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(task.ref)}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        opacity: isDragging ? 0.35 : dimmed ? 0.45 : 1,
      }}
      className="group relative cursor-grab overflow-hidden rounded-xl border border-white/[.065] bg-ink-900/90 p-3 shadow-[0_8px_22px_rgba(0,0,0,.12)] outline-none transition-all duration-150 hover:-translate-y-px hover:border-white/[.115] hover:bg-ink-875 hover:shadow-[0_12px_28px_rgba(0,0,0,.2)] focus-visible:ring-2 focus-visible:ring-accent/45 active:cursor-grabbing active:translate-y-0"
    >
      <span
        className="absolute inset-y-3 left-0 w-0.5 rounded-r-full opacity-85"
        style={{ background: PRIORITY_COLOR[task.priority] }}
      />

      <div className="flex items-center gap-2">
        <span className="font-mono text-[9.5px] tracking-[0.025em] text-ink-600">{task.ref}</span>
        <span className="h-3 w-px bg-white/[.06]" />
        <span className="flex min-w-0 items-center gap-1.5 text-[9.5px] text-ink-500">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: task.project_color }} />
          <span className="truncate">{task.project_name}</span>
        </span>
        <GripVertical className="ml-auto size-3.5 text-ink-700 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <h3 className="mt-2 line-clamp-3 text-[12.5px] leading-[1.45] font-medium tracking-[-0.005em] text-ink-100">
        {task.title}
      </h3>

      {task.question && (
        <div className="mt-2.5 rounded-lg border border-status-input/18 bg-status-input/[.065] p-2.5">
          <div className="flex items-center gap-1.5 text-status-input">
            <MessageSquare className="size-3" />
            <p className="text-[9px] font-semibold tracking-[0.1em] uppercase">{task.question_from ?? 'Agent'} asks</p>
          </div>
          <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-ink-200">{task.question}</p>
        </div>
      )}

      {(blocked || stale || snoozed || overdue || shownTags.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {blocked && (
            <Badge variant="danger" title={`Blocked by ${task.blocked_by.join(', ')}`}>
              <CircleAlert className="size-2.5" /> blocked
            </Badge>
          )}
          {stale && (
            <Badge variant="warning" title="Lease expired">
              <Clock3 className="size-2.5" /> abandoned
            </Badge>
          )}
          {snoozed && (
            <Badge variant="secondary">
              <MoonStar className="size-2.5" /> {relativeTime(task.snooze_until!)}
            </Badge>
          )}
          {overdue && (
            <Badge variant="danger">
              <CalendarClock className="size-2.5" /> {relativeTime(task.due_at!)}
            </Badge>
          )}
          {shownTags.map((tag) => (
            <Badge key={tag} variant="secondary">#{tag}</Badge>
          ))}
          {task.tags.length > shownTags.length && (
            <Badge variant="outline">+{task.tags.length - shownTags.length}</Badge>
          )}
        </div>
      )}

      {(task.assignee || task.comment_count > 0 || task.due_at || task.recur) && (
        <footer className="mt-2.5 flex items-center gap-2 border-t border-white/[.045] pt-2 text-[9.5px] text-ink-600">
          {task.due_at && !overdue && (
            <span className="flex items-center gap-1">
              <CalendarClock className="size-3" /> {relativeTime(task.due_at)}
            </span>
          )}
          {task.recur && <Repeat2 className="size-3" aria-label="Recurring task" />}
          {task.comment_count > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare className="size-3" /> {task.comment_count}
            </span>
          )}
          {task.assignee && (
            <span className={cn('ml-auto flex max-w-[120px] items-center gap-1 rounded-md bg-accent/[.08] px-1.5 py-0.5 text-accent-soft')}>
              <UserRound className="size-2.5 shrink-0" />
              <span className="truncate">{task.assignee}</span>
            </span>
          )}
        </footer>
      )}
    </article>
  );
}
