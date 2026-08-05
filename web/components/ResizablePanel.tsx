import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { cn } from '../lib/utils.ts';

type ResizeOptions = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  mobileCap: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  mobileCap,
}: ResizeOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(stored, minWidth, maxWidth) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const widthRef = useRef(width);
  const cleanupRef = useRef<(() => void) | null>(null);

  const update = (next: number) => {
    const clamped = clamp(next, minWidth, maxWidth);
    widthRef.current = clamped;
    setWidth(clamped);
  };

  const persist = () => {
    try {
      localStorage.setItem(storageKey, String(widthRef.current));
    } catch {
      // Persistence is a convenience; resizing still works when storage is unavailable.
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = (moveEvent: globalThis.PointerEvent) => {
      update(startWidth + startX - moveEvent.clientX);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      cleanupRef.current = null;
      persist();
    };

    cleanupRef.current?.();
    cleanupRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    update(widthRef.current + (event.key === 'ArrowLeft' ? 20 : -20));
    persist();
  };

  useEffect(() => () => cleanupRef.current?.(), []);

  return {
    width,
    panelStyle: {
      '--panel-width': `${width}px`,
      '--panel-mobile-cap': `${mobileCap}px`,
    } as CSSProperties,
    handleProps: {
      min: minWidth,
      max: maxWidth,
      value: width,
      onPointerDown,
      onKeyDown,
    },
  };
}

export function PanelResizeHandle({
  min,
  max,
  value,
  label,
  className,
  onPointerDown,
  onKeyDown,
}: {
  min: number;
  max: number;
  value: number;
  label: string;
  className?: string;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title="Drag to resize · Arrow keys for fine control"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'group absolute inset-y-0 left-0 z-20 hidden w-3 -translate-x-1/2 cursor-col-resize items-center justify-center outline-none xl:flex',
        className,
      )}
    >
      <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-accent/40 group-focus-visible:bg-accent/55" />
      <span className="relative grid h-9 w-3 place-items-center rounded-full border border-white/[.07] bg-ink-850 text-ink-650 opacity-0 shadow-lg transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-active:scale-95 group-active:text-accent-soft">
        <GripVertical className="size-2.5" />
      </span>
    </button>
  );
}
