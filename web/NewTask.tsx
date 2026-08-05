import { useEffect, useRef, useState } from 'react';

import { PRIORITY_COLOR, api, type Project } from './api.ts';

const field =
  'w-full rounded-md border border-ink-800 bg-ink-950 px-3 py-2 text-[13px] text-ink-50 ' +
  'outline-none transition-colors placeholder:text-ink-600 focus:border-accent-dim';

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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
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
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        deps: deps.split(',').map((d) => d.trim()).filter(Boolean),
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-xl border border-ink-800 bg-ink-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      >
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          className="w-full bg-transparent text-[17px] font-medium text-ink-50 outline-none
                     placeholder:text-ink-600"
        />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Description — Markdown, acceptance criteria, links…"
          className={`${field} mt-3 resize-y`}
        />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <select value={project} onChange={(e) => setProject(e.target.value)} className={field}>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="flex gap-1">
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                style={{
                  color: priority === p ? PRIORITY_COLOR[p] : undefined,
                  borderColor: priority === p ? PRIORITY_COLOR[p] : undefined,
                }}
                className={`flex-1 rounded-md border py-2 text-[12px] transition-colors ${
                  priority === p ? 'bg-ink-850' : 'border-ink-800 text-ink-500 hover:bg-ink-850'
                }`}
              >
                P{p}
              </button>
            ))}
          </div>

          <input
            value={due}
            onChange={(e) => setDue(e.target.value)}
            placeholder="Due — friday, 3d, 2026-08-12"
            className={field}
          />
          <input
            value={recur}
            onChange={(e) => setRecur(e.target.value)}
            placeholder="Repeat — 0 9 * * 1"
            className={`${field} font-mono`}
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags — api, infra"
            className={field}
          />
          <input
            value={deps}
            onChange={(e) => setDeps(e.target.value)}
            placeholder="Blocked by — demo-3"
            className={field}
          />
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-p0/30 bg-p0/10 px-2.5 py-2 text-[12px] text-p0">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[11px] text-ink-600">⌘↵ to create · Esc to cancel</span>
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1.5 text-[12px] text-ink-400
                       transition-colors hover:bg-ink-850"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950
                       transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
