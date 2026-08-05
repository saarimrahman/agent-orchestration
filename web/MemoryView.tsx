import { useEffect, useMemo, useState } from 'react';

import { api, type MemoryDocument } from './api.ts';
import { renderMarkdown } from './markdown.ts';

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
    return <p className="px-4 py-8 text-[13px] text-p0">Could not load memory: {error}</p>;
  }
  if (!memories) {
    return <p className="px-4 py-8 text-[13px] text-ink-500">Loading memory…</p>;
  }

  return (
    <div className="h-full overflow-y-auto px-4 pb-6">
      <div className="mb-3 flex items-baseline gap-2">
        <h1 className="text-[14px] font-semibold text-ink-50">Durable memory</h1>
        <span className="text-[12px] text-ink-600">
          {shown.length} of {memories.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-800 px-5 py-12 text-center">
          <p className="text-[13px] text-ink-300">No memories here yet.</p>
          <p className="mt-1 text-[12px] text-ink-600">
            Agents can save one with <code>orch remember &quot;…&quot;</code>.
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {shown.map((memory) => (
            <article key={memory.id} className="rounded-xl border border-ink-800 bg-ink-900 p-4">
              <div className="flex items-start gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
                  <span className="rounded bg-accent/12 px-1.5 py-0.5 text-accent">{memory.kind}</span>
                  <span className="rounded bg-ink-850 px-1.5 py-0.5 text-ink-400">
                    {memory.project_key ?? 'global'}
                  </span>
                  <span className="rounded bg-ink-850 px-1.5 py-0.5 text-ink-500">
                    {memory.status}
                  </span>
                </div>
                <button
                  onClick={() => setEditing(memory)}
                  className="ml-auto rounded px-2 py-1 text-[11px] text-ink-500 transition-colors
                             hover:bg-ink-850 hover:text-ink-200"
                >
                  Edit
                </button>
              </div>
              <h2 className="mt-2 text-[14px] font-medium text-ink-50">{memory.title}</h2>
              <div
                className="prose-orch mt-2 text-[12.5px] text-ink-300"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.body) }}
              />
              {(memory.tags.length > 0 || memory.sources.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1 border-t border-ink-850 pt-3 text-[10px] text-ink-500">
                  {memory.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                  {memory.sources.map((source) => <span key={source}>source:{source}</span>)}
                </div>
              )}
            </article>
          ))}
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
  'w-full rounded-md border border-ink-800 bg-ink-950 px-3 py-2 text-[13px] text-ink-50 ' +
  'outline-none transition-colors placeholder:text-ink-600 focus:border-accent-dim';

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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[8vh]" onClick={onClose}>
      <div
        className="w-[680px] rounded-xl border border-ink-800 bg-ink-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4">
          <p className="text-[14px] font-semibold text-ink-50">Edit memory</p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-600">{memory.id}</p>
        </div>

        <input value={title} onChange={(event) => setTitle(event.target.value)} className={field} />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={12}
          className={`${field} mt-3 resize-y font-mono leading-relaxed`}
        />

        <div className="mt-3 grid grid-cols-2 gap-3">
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className={field}>
            {KINDS.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={field}>
            {STATUSES.map((value) => <option key={value}>{value}</option>)}
          </select>
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" className={field} />
          <input value={sources} onChange={(event) => setSources(event.target.value)} placeholder="Sources, comma separated" className={field} />
        </div>

        {error && <p className="mt-3 text-[12px] text-p0">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-ink-400 hover:bg-ink-850">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!title.trim() || !body.trim() || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-35"
          >
            {busy ? 'Saving…' : 'Save memory'}
          </button>
        </div>
      </div>
    </div>
  );
}
