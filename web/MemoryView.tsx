import { useEffect, useMemo, useState } from 'react';

import { api, type MemoryDocument } from './api.ts';
import { renderMarkdown } from './markdown.ts';

export function MemoryView({ query, project }: { query: string; project: string | null }) {
  const [memories, setMemories] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
                <span className="rounded bg-accent/12 px-1.5 py-0.5 text-accent">{memory.kind}</span>
                <span className="rounded bg-ink-850 px-1.5 py-0.5 text-ink-400">
                  {memory.project_key ?? 'global'}
                </span>
                <span className="rounded bg-ink-850 px-1.5 py-0.5 text-ink-500">
                  {memory.status}
                </span>
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
    </div>
  );
}
