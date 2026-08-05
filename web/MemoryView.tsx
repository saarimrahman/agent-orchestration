import {
  BookOpen,
  Brain,
  CheckCircle2,
  FileText,
  Lightbulb,
  Pencil,
  Save,
  ShieldAlert,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api, type MemoryDocument } from './api.ts';
import { Badge } from './components/ui/badge.tsx';
import { Button } from './components/ui/button.tsx';
import { cn } from './lib/utils.ts';
import { renderMarkdown } from './markdown.ts';

const KIND_ICON: Record<MemoryDocument['kind'], LucideIcon> = {
  fact: CheckCircle2,
  decision: Lightbulb,
  pitfall: ShieldAlert,
  playbook: BookOpen,
  preference: Sparkles,
  note: FileText,
};

export function MemoryView({ query, project }: { query: string; project: string | null }) {
  const [memories, setMemories] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryDocument | null>(null);

  useEffect(() => {
    let alive = true;
    void api.memories().then(
      (next) => {
        if (alive) setMemories(next);
      },
      (err: Error) => {
        if (alive) setError(err.message);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!memories) return [];
    const needle = query.trim().toLowerCase();
    return memories.filter((memory) => {
      if (project && memory.project_key !== project) return false;
      if (!needle) return true;
      return [
        memory.title,
        memory.body,
        memory.kind,
        memory.status,
        memory.project_key ?? 'global',
        ...memory.tags,
        ...memory.sources,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [memories, project, query]);

  if (error) {
    return <p className="mx-5 rounded-lg border border-p0/20 bg-p0/[.08] px-3 py-2 text-[11px] text-p0">Could not load memory: {error}</p>;
  }
  if (!memories) {
    return (
      <div className="flex items-center gap-2 px-5 py-8 text-[11px] text-ink-600">
        <span className="size-4 animate-spin rounded-full border-2 border-ink-700 border-t-accent" /> Loading memory…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 pb-6 sm:px-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl border border-accent/15 bg-accent/[.08] text-accent-soft">
          <Brain className="size-4" />
        </span>
        <div>
          <h1 className="text-[14px] font-semibold tracking-[-0.01em] text-ink-50">Durable memory</h1>
          <p className="mt-0.5 text-[10.5px] text-ink-600">Verified knowledge that follows work across tasks</p>
        </div>
        <Badge variant="secondary" className="ml-auto">{shown.length} of {memories.length}</Badge>
      </div>

      {shown.length === 0 ? (
        <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/[.065] bg-white/[.015] px-5 text-center">
          <div>
            <Brain className="mx-auto size-5 text-ink-700" />
            <p className="mt-3 text-[12px] text-ink-300">No memories found</p>
            <p className="mt-1 text-[10.5px] text-ink-600">Agents can save one with <code className="text-ink-400">orchestration remember &quot;…&quot;</code>.</p>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {shown.map((memory) => {
            const KindIcon = KIND_ICON[memory.kind];
            return (
              <article key={memory.id} className="group rounded-2xl border border-white/[.06] bg-ink-900/75 p-4 shadow-[0_12px_30px_rgba(0,0,0,.1)] transition-all hover:-translate-y-px hover:border-white/[.105] hover:bg-ink-875">
                <div className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-accent/12 bg-accent/[.07] text-accent-soft">
                    <KindIcon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge>{memory.kind}</Badge>
                      <Badge variant="secondary">{memory.project_key ?? 'global'}</Badge>
                      <Badge variant={memory.status === 'active' ? 'success' : 'outline'}>{memory.status}</Badge>
                    </div>
                    <h2 className="mt-2 text-[13px] font-semibold tracking-[-0.005em] text-ink-50">{memory.title}</h2>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(memory)} className="-mt-1 opacity-70 group-hover:opacity-100">
                    <Pencil /> Edit
                  </Button>
                </div>
                <div
                  className="prose-orchestration mt-3 text-[11.5px] text-ink-400"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.body) }}
                />
                {(memory.tags.length > 0 || memory.sources.length > 0) && (
                  <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 border-t border-white/[.045] pt-3 text-[9.5px] text-ink-650">
                    {memory.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                    {memory.sources.map((source) => <span key={source}>source:{source}</span>)}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {editing && (
        <MemoryEditor
          memory={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setMemories((current) => current?.map((memory) => memory.id === updated.id ? updated : memory) ?? null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const field =
  'h-9 w-full rounded-lg border border-white/[.065] bg-ink-950/70 px-3 text-[12px] text-ink-50 ' +
  'shadow-sm outline-none transition-all placeholder:text-ink-650 hover:border-white/10 ' +
  'focus:border-accent/45 focus:ring-3 focus:ring-accent/10';

const KINDS = ['fact', 'decision', 'pitfall', 'playbook', 'preference', 'note'] as const;
const STATUSES = ['candidate', 'active', 'superseded', 'archived'] as const;

function MemoryEditor({
  memory,
  onClose,
  onSaved,
}: {
  memory: MemoryDocument;
  onClose: () => void;
  onSaved: (memory: MemoryDocument) => void;
}) {
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const [kind, setKind] = useState(memory.kind);
  const [status, setStatus] = useState(memory.status);
  const [tags, setTags] = useState(memory.tags.join(', '));
  const [sources, setSources] = useState(memory.sources.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    try {
      const updated = await api.updateMemory(memory.id, {
        title: title.trim(),
        body: body.trim(),
        kind,
        status,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        sources: sources.split(',').map((source) => source.trim()).filter(Boolean),
      });
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-3 py-[7vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-memory-title"
        className="dialog-panel surface-shadow w-full max-w-[700px] overflow-hidden rounded-2xl border border-white/[.08] bg-ink-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-white/[.055] px-5 py-4">
          <span className="grid size-9 place-items-center rounded-xl border border-accent/15 bg-accent/10 text-accent-soft"><Brain className="size-4" /></span>
          <div>
            <h2 id="edit-memory-title" className="text-[14px] font-semibold text-ink-50">Edit memory</h2>
            <p className="mt-0.5 font-mono text-[9px] text-ink-650">{memory.id}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto"><X /><span className="sr-only">Close</span></Button>
        </header>

        <div className="space-y-3 p-5">
          <input value={title} onChange={(event) => setTitle(event.target.value)} className={field} aria-label="Memory title" />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={12}
            className={cn(field, 'h-auto resize-y py-2.5 font-mono text-[11px] leading-relaxed')}
            aria-label="Memory body"
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className={field} aria-label="Memory kind">
              {KINDS.map((value) => <option key={value}>{value}</option>)}
            </select>
            <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={field} aria-label="Memory status">
              {STATUSES.map((value) => <option key={value}>{value}</option>)}
            </select>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" className={field} />
            <input value={sources} onChange={(event) => setSources(event.target.value)} placeholder="Sources, comma separated" className={field} />
          </div>

          {error && <p className="rounded-lg border border-p0/20 bg-p0/[.08] px-3 py-2 text-[11px] text-p0">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/[.055] bg-black/10 px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={!title.trim() || !body.trim() || busy}>
            <Save /> {busy ? 'Saving…' : 'Save memory'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
