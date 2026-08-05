import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import { useState } from 'react';

import { COLUMNS, type Status, type Task } from './api.ts';
import { TaskCard } from './TaskCard.tsx';

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

  return (
    <div className="flex min-w-[268px] flex-1 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <h2 className="text-[12px] font-medium tracking-wide text-ink-200 uppercase">{label}</h2>
        <span className="text-[11px] text-ink-500">{tasks.length}</span>
      </div>

      <div
        ref={setNodeRef}
        className={`flex flex-1 flex-col gap-2 rounded-xl border border-dashed p-2 transition-colors ${
          isOver ? 'border-accent/50 bg-accent/5' : 'border-ink-850 bg-ink-900/25'
        }`}
      >
        {tasks.map((task) => (
          <TaskCard key={task.ref} task={task} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && (
          <p className="px-1 py-6 text-center text-[12px] text-ink-600">Nothing here</p>
        )}
      </div>
    </div>
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
    setDragging(tasks.find((t) => t.ref === event.active.id) ?? null);
  };

  const end = (event: DragEndEvent) => {
    setDragging(null);
    const status = event.over?.id as Status | undefined;
    const ref = String(event.active.id);
    const task = tasks.find((t) => t.ref === ref);
    if (status && task && task.status !== status) onMove(ref, status);
  };

  return (
    <DndContext sensors={sensors} onDragStart={start} onDragEnd={end} onDragCancel={() => setDragging(null)}>
      <div className="flex h-full gap-3 overflow-x-auto px-4 pb-4">
        {COLUMNS.map((column) => (
          <Column
            key={column.status}
            {...column}
            tasks={tasks.filter((t) => t.status === column.status)}
            onOpen={onOpen}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="rotate-1 opacity-95">
            <TaskCard task={dragging} onOpen={() => {}} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
