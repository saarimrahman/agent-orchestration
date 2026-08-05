import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { Check, Circle, CircleHelp, Eye, LoaderCircle, Sparkles } from 'lucide-react';
import { useState, type ComponentType } from 'react';

import { COLUMNS, type Status, type Task } from './api.ts';
import { cn } from './lib/utils.ts';
import { TaskCard } from './TaskCard.tsx';

const STATUS_ICON: Record<Status, ComponentType<{ className?: string }>> = {
  backlog: Circle,
  ready: Sparkles,
  in_progress: LoaderCircle,
  needs_input: CircleHelp,
  review: Eye,
  done: Check,
  cancelled: Circle,
};

function Column({
  status,
  label,
  color,
  tasks,
  onOpen,
}: {
  status: Status;
  label: string;
  color: string;
  tasks: Task[];
  onOpen: (ref: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const Icon = STATUS_ICON[status];

  return (
    <section className="flex min-w-[284px] max-w-[350px] flex-1 flex-col">
      <header className="mb-2 flex h-8 items-center gap-2 px-1.5">
        <span
          className="grid size-5 place-items-center rounded-md border"
          style={{ color, background: `color-mix(in srgb, ${color} 10%, transparent)`, borderColor: `color-mix(in srgb, ${color} 18%, transparent)` }}
        >
          <Icon className={cn('size-3', status === 'in_progress' && 'animate-spin')} />
        </span>
        <h2 className="text-[11px] font-semibold tracking-[0.055em] text-ink-300 uppercase">{label}</h2>
        <span className="rounded-md bg-white/[.045] px-1.5 py-0.5 text-[9.5px] font-medium text-ink-600">{tasks.length}</span>
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'relative flex flex-1 flex-col gap-2 rounded-xl border p-2 transition-all duration-200',
          isOver
            ? 'border-accent/35 bg-accent/[.055] shadow-[0_0_0_3px_rgba(124,135,248,.06)_inset]'
            : 'border-white/[.045] bg-white/[.018]',
        )}
      >
        <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/[.055] to-transparent" />
        {tasks.map((task) => (
          <TaskCard key={task.ref} task={task} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && (
          <div className="grid min-h-24 flex-1 place-items-center rounded-lg border border-dashed border-white/[.045]">
            <div className="text-center">
              <Circle className="mx-auto size-3.5 text-ink-700" />
              <p className="mt-1.5 text-[10.5px] text-ink-650">No tasks here</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function Board({
  tasks,
  onOpen,
  onMove,
}: {
  tasks: Task[];
  onOpen: (ref: string) => void;
  onMove: (ref: string, status: Status) => void;
}) {
  const [dragging, setDragging] = useState<Task | null>(null);

  // A small activation distance keeps a click-to-open from registering as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const start = (event: DragStartEvent) => {
    setDragging(tasks.find((task) => task.ref === event.active.id) ?? null);
  };

  const end = (event: DragEndEvent) => {
    setDragging(null);
    const status = event.over?.id as Status | undefined;
    const ref = String(event.active.id);
    const task = tasks.find((item) => item.ref === ref);
    if (status && task && task.status !== status) onMove(ref, status);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={start}
      onDragEnd={end}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full gap-3 overflow-x-auto px-4 pb-4 sm:px-5">
        {COLUMNS.map((column) => (
          <Column
            key={column.status}
            {...column}
            tasks={tasks.filter((task) => task.status === column.status)}
            onOpen={onOpen}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="w-[300px] rotate-[1.5deg] opacity-95 shadow-2xl">
            <TaskCard task={dragging} onOpen={() => {}} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
