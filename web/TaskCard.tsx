import { useDraggable } from '@dnd-kit/core';
import {
  PRIORITY_COLOR,
  isOverdue,
  isSnoozed,
  leaseExpired,
  relativeTime,
  type Task,
} from './api.ts';

type Props = {
  task: Task;
  onOpen: (ref: string) => void;
  dimmed?: boolean;
};

export function TaskCard({ task, onOpen, dimmed }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.ref,
  });

  const blocked = task.blocked_by.length > 0;
  const overdue = isOverdue(task) && task.status !== 'done';
  const snoozed = isSnoozed(task);
  const stale = leaseExpired(task);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(task.ref)}
      style={{
        borderLeftColor: PRIORITY_COLOR[task.priority],
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        opacity: isDragging ? 0.4 : dimmed ? 0.45 : 1,
      }}
      className="group cursor-grab rounded-lg border border-ink-800 border-l-3 bg-ink-900
                 px-3 py-2.5 shadow-sm transition-colors hover:border-ink-700 hover:bg-ink-850
                 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] tracking-tight text-ink-500">{task.ref}</span>
        <span
          className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: task.project_color }}
          title={task.project_name}
        />
      </div>

      <p className="mt-1 text-[13px] leading-snug text-ink-50">{task.title}</p>

      {(task.tags.length > 0 || task.assignee || task.due_at || blocked || snoozed || stale) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {blocked && (
            <span
              className="rounded bg-p0/12 px-1.5 py-0.5 text-p0"
              title={`Blocked by ${task.blocked_by.join(', ')}`}
            >
              blocked
            </span>
          )}
          {stale && (
            <span className="rounded bg-p1/12 px-1.5 py-0.5 text-p1" title="Lease expired">
              abandoned
            </span>
          )}
          {snoozed && (
            <span className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-400">
              ↩ {relativeTime(task.snooze_until!)}
            </span>
          )}
          {task.due_at && (
            <span className={overdue ? 'text-p0' : 'text-ink-400'}>
              {overdue ? '⚠ ' : ''}
              {relativeTime(task.due_at)}
            </span>
          )}
          {task.recur && <span className="text-ink-500" title={task.recur}>↻</span>}
          {task.tags.map((tag) => (
            <span key={tag} className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-400">
              {tag}
            </span>
          ))}
          {task.comment_count > 0 && (
            <span className="text-ink-500">💬 {task.comment_count}</span>
          )}
          {task.assignee && (
            <span className="ml-auto rounded bg-accent/12 px-1.5 py-0.5 text-accent">
              {task.assignee}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
