import {
  AlignLeft,
  CalendarDays,
  Folder,
  Link2,
  ListPlus,
  Repeat2,
  Tags,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { PRIORITY_COLOR, api, type Project } from './api.ts';
import { Button } from './components/ui/button.tsx';
import { cn } from './lib/utils.ts';

const field =
  'h-9 w-full rounded-lg border border-white/[.065] bg-ink-950/70 px-3 text-[12px] text-ink-50 ' +
  'shadow-sm outline-none transition-all placeholder:text-ink-650 hover:border-white/10 ' +
  'focus:border-accent/45 focus:ring-3 focus:ring-accent/10';

export function NewTask({
  projects,
  defaultProject,
  onClose,
  onCreated,
}: {
  projects: Project[];
  defaultProject?: string;
  onClose: () => void;
  onCreated: (ref: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [project, setProject] = useState(defaultProject ?? projects[0]?.key ?? '');
  const [priority, setPriority] = useState(2);
  const [due, setDue] = useState('');
  const [recur, setRecur] = useState('');
  const [tags, setTags] = useState('');
  const [deps, setDeps] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const task = await api.create({
        title: title.trim(),
        project,
        body,
        priority,
        due: due.trim() || null,
        recur: recur.trim() || null,
        tags: tags.split(',').map((item) => item.trim()).filter(Boolean),
        deps: deps.split(',').map((item) => item.trim()).filter(Boolean),
        actor: 'you',
      });
      await onCreated(task.ref);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-3 py-[8vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        className="dialog-panel surface-shadow w-full max-w-[620px] overflow-hidden rounded-2xl border border-white/[.08] bg-ink-900"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
        }}
      >
        <header className="flex items-center gap-3 border-b border-white/[.055] px-5 py-4">
          <span className="grid size-9 place-items-center rounded-xl border border-accent/15 bg-accent/10 text-accent-soft">
            <ListPlus className="size-4" />
          </span>
          <div>
            <h2 id="new-task-title" className="text-[14px] font-semibold text-ink-50">Create a task</h2>
            <p className="mt-0.5 text-[10.5px] text-ink-600">Capture enough context for anyone to pick it up.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto">
            <X />
            <span className="sr-only">Close</span>
          </Button>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <label htmlFor="task-title" className="text-[10px] font-semibold tracking-[0.08em] text-ink-500 uppercase">Title</label>
            <input
              id="task-title"
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              className="mt-1.5 w-full bg-transparent text-[17px] leading-snug font-medium tracking-[-0.01em] text-ink-50 outline-none placeholder:text-ink-650"
            />
          </div>

          <FieldLabel icon={AlignLeft} label="Description">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              placeholder="Add context, acceptance criteria, or links… Markdown is supported."
              className={cn(field, 'h-auto resize-y py-2.5 leading-relaxed')}
            />
          </FieldLabel>

          <div className="grid gap-3 sm:grid-cols-2">
            <FieldLabel icon={Folder} label="Project">
              <select value={project} onChange={(event) => setProject(event.target.value)} className={field}>
                {projects.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
              </select>
            </FieldLabel>

            <div>
              <p className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-500 uppercase">Priority</p>
              <div className="flex h-9 gap-1 rounded-lg border border-white/[.065] bg-ink-950/70 p-1">
                {[0, 1, 2, 3].map((value) => (
                  <button
                    key={value}
                    onClick={() => setPriority(value)}
                    style={{ color: priority === value ? PRIORITY_COLOR[value] : undefined }}
                    className={cn(
                      'flex-1 rounded-md text-[10.5px] font-medium transition-all',
                      priority === value
                        ? 'bg-white/[.075] shadow-sm'
                        : 'text-ink-600 hover:bg-white/[.035] hover:text-ink-400',
                    )}
                  >
                    P{value}
                  </button>
                ))}
              </div>
            </div>

            <FieldLabel icon={CalendarDays} label="Due date">
              <input value={due} onChange={(event) => setDue(event.target.value)} placeholder="friday, 3d, 2026-08-12" className={field} />
            </FieldLabel>
            <FieldLabel icon={Repeat2} label="Repeat">
              <input value={recur} onChange={(event) => setRecur(event.target.value)} placeholder="0 9 * * 1" className={cn(field, 'font-mono')} />
            </FieldLabel>
            <FieldLabel icon={Tags} label="Tags">
              <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="api, infra" className={field} />
            </FieldLabel>
            <FieldLabel icon={Link2} label="Blocked by">
              <input value={deps} onChange={(event) => setDeps(event.target.value)} placeholder="general-3, demo-7" className={field} />
            </FieldLabel>
          </div>

          {error && <p className="rounded-lg border border-p0/20 bg-p0/[.08] px-3 py-2 text-[11px] text-p0">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-white/[.055] bg-black/10 px-5 py-3.5">
          <span className="hidden text-[10px] text-ink-650 sm:inline">⌘↵ to create · Esc to cancel</span>
          <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!title.trim() || busy}>
            <ListPlus /> {busy ? 'Creating…' : 'Create task'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function FieldLabel({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-500 uppercase">
        <Icon className="size-3" /> {label}
      </span>
      {children}
    </label>
  );
}
