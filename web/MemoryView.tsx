import {
  ArrowUpDown,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileText,
  Lightbulb,
  ListFilter,
  Pencil,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
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

const KINDS = ['fact', 'decision', 'pitfall', 'playbook', 'preference', 'note'] as const;
const STATUSES = ['candidate', 'active', 'superseded', 'archived'] as const;
type MemorySort = 'updated-desc' | 'updated-asc' | 'title-asc' | 'title-desc' | 'kind' | 'status' | 'project' | 'tag';

const filterField =
  'h-8 rounded-lg border border-white/[.065] bg-ink-950/65 px-2.5 text-[11px] text-ink-200 ' +
  'outline-none transition-colors hover:border-white/10 focus:border-accent/45 focus:ring-2 focus:ring-accent/10';

function displayLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('-', ' ');
}

const TAG_COLORS = ['#7c8cff', '#2dd4bf', '#f59e0b', '#fb7185', '#a78bfa', '#38bdf8', '#4ade80'];

function tagColor(tag: string): string {
  let hash = 0;
  for (const character of tag) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function MemoryMetadata({ memory, className }: { memory: MemoryDocument; className?: string }) {
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      <Badge data-memory-meta="kind">{memory.kind}</Badge>
      <Badge data-memory-meta="scope" variant="secondary">{memory.project_key ?? 'global'}</Badge>
      <Badge data-memory-meta="status" variant={memory.status === 'active' ? 'success' : 'outline'}>{memory.status}</Badge>
      {memory.tags.map((tag) => {
        const color = tagColor(tag);
        return (
          <Badge
            key={tag}
            data-memory-tag={tag}
            variant="outline"
            style={{ color, borderColor: `${color}33`, backgroundColor: `${color}14` }}
          >
            #{tag}
          </Badge>
        );
      })}
    </span>
  );
}

export function MemoryView({ query, project }: { query: string; project: string | null }) {
  const [memories, setMemories] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [editing, setEditing] = useState<MemoryDocument | null>(null);
  const [deleting, setDeleting] = useState<MemoryDocument | null>(null);
  const [tagFilter, setTagFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState<MemoryDocument['kind'] | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MemoryDocument['status'] | 'all'>('all');
  const [scopeFilter, setScopeFilter] = useState<MemoryDocument['scope'] | 'all'>('all');
  const [sort, setSort] = useState<MemorySort>('updated-desc');

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

  const scopedMemories = useMemo(
    () => memories?.filter((memory) => !project || memory.project_key === project) ?? [],
    [memories, project],
  );

  const availableTags = useMemo(
    () => [...new Set(scopedMemories.flatMap((memory) => memory.tags))]
      .sort((a, b) => a.localeCompare(b)),
    [scopedMemories],
  );

  useEffect(() => {
    if (tagFilter !== 'all' && !availableTags.includes(tagFilter)) setTagFilter('all');
  }, [availableTags, tagFilter]);

  const shown = useMemo(() => {
    if (!memories) return [];
    const needle = query.trim().toLowerCase();
    const filtered = memories.filter((memory) => {
      if (project && memory.project_key !== project) return false;
      if (tagFilter !== 'all' && !memory.tags.includes(tagFilter)) return false;
      if (kindFilter !== 'all' && memory.kind !== kindFilter) return false;
      if (statusFilter !== 'all' && memory.status !== statusFilter) return false;
      if (scopeFilter !== 'all' && memory.scope !== scopeFilter) return false;
      if (needle && ![
          memory.title,
          memory.body,
          memory.kind,
          memory.status,
          memory.project_key ?? 'global',
          ...memory.tags,
          ...memory.sources,
        ].some((value) => value.toLowerCase().includes(needle))) return false;
      return true;
    });

    const byTitle = (a: MemoryDocument, b: MemoryDocument) =>
      a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    return filtered.sort((a, b) => {
      switch (sort) {
        case 'updated-asc': return a.updated_at.localeCompare(b.updated_at) || byTitle(a, b);
        case 'title-asc': return byTitle(a, b);
        case 'title-desc': return byTitle(b, a);
        case 'kind': return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || byTitle(a, b);
        case 'status': return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byTitle(a, b);
        case 'project': return (a.project_key ?? '').localeCompare(b.project_key ?? '') || byTitle(a, b);
        case 'tag': return (a.tags[0] ?? '').localeCompare(b.tags[0] ?? '') || byTitle(a, b);
        default: return b.updated_at.localeCompare(a.updated_at) || byTitle(a, b);
      }
    });
  }, [kindFilter, memories, project, query, scopeFilter, sort, statusFilter, tagFilter]);

  const hasFilters = tagFilter !== 'all' || kindFilter !== 'all' || statusFilter !== 'all' || scopeFilter !== 'all';
  const clearFilters = () => {
    setTagFilter('all');
    setKindFilter('all');
    setStatusFilter('all');
    setScopeFilter('all');
  };

  const askToDelete = (memory: MemoryDocument) => {
    setSelected(null);
    setEditing(null);
    setDeleting(memory);
  };

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
        <Badge variant="secondary" className="ml-auto">{shown.length} of {scopedMemories.length}</Badge>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/[.055] bg-white/[.018] p-2">
        <span className="flex items-center gap-1.5 px-1 text-[10.5px] font-medium text-ink-500">
          <ListFilter className="size-3.5" /> Filter
        </span>
        <select
          value={tagFilter}
          onChange={(event) => setTagFilter(event.target.value)}
          aria-label="Filter memories by tag"
          className={filterField}
        >
          <option value="all">All tags</option>
          {availableTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
        </select>
        <select
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}
          aria-label="Filter memories by kind"
          className={filterField}
        >
          <option value="all">All kinds</option>
          {KINDS.map((kind) => <option key={kind} value={kind}>{displayLabel(kind)}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          aria-label="Filter memories by status"
          className={filterField}
        >
          <option value="all">All statuses</option>
          {STATUSES.map((status) => <option key={status} value={status}>{displayLabel(status)}</option>)}
        </select>
        <select
          value={scopeFilter}
          onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}
          aria-label="Filter memories by scope"
          className={filterField}
        >
          <option value="all">All scopes</option>
          <option value="global">Global</option>
          <option value="project">Project</option>
        </select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 px-2 text-[11px]">
            <RotateCcw /> Clear
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5 px-1 text-[10.5px] font-medium text-ink-500">
          <ArrowUpDown className="size-3.5" /> Sort
        </span>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as MemorySort)}
          aria-label="Sort memories"
          className={filterField}
        >
          <option value="updated-desc">Recently updated</option>
          <option value="updated-asc">Least recently updated</option>
          <option value="title-asc">Title A–Z</option>
          <option value="title-desc">Title Z–A</option>
          <option value="kind">Kind</option>
          <option value="status">Status</option>
          <option value="project">Project</option>
          <option value="tag">Tag</option>
        </select>
      </div>

      {shown.length === 0 ? (
        <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/[.065] bg-white/[.015] px-5 text-center">
          <div>
            <Brain className="mx-auto size-5 text-ink-700" />
            <p className="mt-3 text-[12px] text-ink-300">{hasFilters || query.trim() ? 'No matching memories' : 'No memories found'}</p>
            <p className="mt-1 text-[10.5px] text-ink-600">
              {hasFilters || query.trim()
                ? 'Adjust the search or clear the memory filters.'
                : <>Agents can save one with <code className="text-ink-400">orchestration remember &quot;…&quot;</code>.</>}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {shown.map((memory) => {
            const KindIcon = KIND_ICON[memory.kind];
            return (
              <button
                key={memory.id}
                type="button"
                aria-label={`View memory: ${memory.title}`}
                onClick={() => setSelected(memory)}
                className="group flex min-w-0 items-start gap-3 rounded-xl border border-white/[.06] bg-ink-900/75 px-3.5 py-3 text-left shadow-[0_10px_25px_rgba(0,0,0,.08)] outline-none transition-all hover:-translate-y-px hover:border-white/[.105] hover:bg-ink-875 focus-visible:ring-2 focus-visible:ring-accent/55"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent/12 bg-accent/[.07] text-accent-soft">
                  <KindIcon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-semibold tracking-[-0.005em] text-ink-50">{memory.title}</span>
                  <MemoryMetadata memory={memory} className="mt-1.5" />
                </span>
                <ChevronRight className="mt-2 size-4 shrink-0 text-ink-700 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-400" />
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <MemoryDetail
          memory={selected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditing(selected);
            setSelected(null);
          }}
          onDelete={() => askToDelete(selected)}
        />
      )}

      {editing && (
        <MemoryEditor
          memory={editing}
          onClose={() => setEditing(null)}
          onDelete={() => askToDelete(editing)}
          onSaved={(updated) => {
            setMemories((current) => current?.map((memory) => memory.id === updated.id ? updated : memory) ?? null);
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <MemoryDeleteDialog
          memory={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setMemories((current) => current?.filter((memory) => memory.id !== deleting.id) ?? null);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function MemoryDetail({
  memory,
  onClose,
  onEdit,
  onDelete,
}: {
  memory: MemoryDocument;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const KindIcon = KIND_ICON[memory.kind];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-3 py-[7vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-detail-title"
        className="dialog-panel surface-shadow w-full max-w-[700px] overflow-hidden rounded-2xl border border-white/[.08] bg-ink-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-white/[.055] px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-accent/15 bg-accent/10 text-accent-soft"><KindIcon className="size-4" /></span>
          <div className="min-w-0">
            <h2 id="memory-detail-title" className="truncate text-[14px] font-semibold text-ink-50">{memory.title}</h2>
            <p className="mt-0.5 truncate font-mono text-[9px] text-ink-650">{memory.id}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto"><X /><span className="sr-only">Close</span></Button>
        </header>

        <div className="p-5">
          <div className="flex flex-wrap items-start gap-2">
            <MemoryMetadata memory={memory} className="flex-1" />
            <span className="ml-auto shrink-0 text-[9.5px] text-ink-650">Updated {new Date(memory.updated_at).toLocaleString()}</span>
          </div>
          <div
            className="prose-orchestration mt-5 text-[12px] text-ink-300"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.body) }}
          />
          {memory.sources.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-x-2 gap-y-1 border-t border-white/[.055] pt-4 text-[10px] text-ink-600">
              {memory.sources.map((source) => <span key={source}>source:{source}</span>)}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-white/[.055] bg-black/10 px-5 py-3.5">
          <Button variant="danger" size="sm" onClick={onDelete}><Trash2 /> Delete</Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">Close</Button>
          <Button size="sm" onClick={onEdit}><Pencil /> Edit memory</Button>
        </footer>
      </div>
    </div>
  );
}

const field =
  'h-9 w-full rounded-lg border border-white/[.065] bg-ink-950/70 px-3 text-[12px] text-ink-50 ' +
  'shadow-sm outline-none transition-all placeholder:text-ink-650 hover:border-white/10 ' +
  'focus:border-accent/45 focus:ring-3 focus:ring-accent/10';

function MemoryEditor({
  memory,
  onClose,
  onSaved,
  onDelete,
}: {
  memory: MemoryDocument;
  onClose: () => void;
  onSaved: (memory: MemoryDocument) => void;
  onDelete: () => void;
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

        <footer className="flex items-center gap-2 border-t border-white/[.055] bg-black/10 px-5 py-3.5">
          <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}><Trash2 /> Delete</Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={!title.trim() || !body.trim() || busy}>
            <Save /> {busy ? 'Saving…' : 'Save memory'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function MemoryDeleteDialog({
  memory,
  onClose,
  onDeleted,
}: {
  memory: MemoryDocument;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteMemory(memory.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-[14vh]" onClick={() => !busy && onClose()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-memory-title"
        aria-describedby="delete-memory-description"
        className="dialog-panel surface-shadow w-full max-w-[460px] overflow-hidden rounded-2xl border border-p0/20 bg-ink-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-5">
          <span className="grid size-10 place-items-center rounded-xl border border-p0/20 bg-p0/10 text-p0"><Trash2 className="size-4" /></span>
          <h2 id="delete-memory-title" className="mt-4 text-[15px] font-semibold text-ink-50">Delete “{memory.title}”?</h2>
          <p id="delete-memory-description" className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
            This removes the memory file and its entry from the board. The private memory Git history preserves a recovery trail.
          </p>
          {error && <p className="mt-4 rounded-lg border border-p0/20 bg-p0/[.08] px-3 py-2 text-[11px] text-p0">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-white/[.055] bg-black/10 px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy}>
            <Trash2 /> {busy ? 'Deleting…' : 'Delete memory'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
