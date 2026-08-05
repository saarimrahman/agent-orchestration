import { useEffect, useState } from 'react';

import {
  COLUMNS,
  PRIORITY_COLOR,
  api,
  relativeTime,
  type Project,
  type TaskDetail,
} from './api.ts';
import { EventLine } from './ActivityFeed.tsx';
import { renderMarkdown } from './markdown.ts';

const label = 'text-[11px] font-medium tracking-wide text-ink-500 uppercase';
const field =
  'w-full rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-[13px] text-ink-50 ' +
  'outline-none transition-colors placeholder:text-ink-600 focus:border-accent-dim';

export function TaskDrawer({
  taskRef,
  projects,
  onClose,
  onChanged,
}: {
  taskRef: string;
  projects: Project[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [editingBody, setEditingBody] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [dueDraft, setDueDraft] = useState('');
  const [snoozeDraft, setSnoozeDraft] = useState('');
  const [depDraft, setDepDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  const load = async () => {
    try {
      const next = await api.task(taskRef);
      setTask(next);
      setDraftBody(next.body);
      setTitleDraft(next.title);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingBody) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editingBody]);

  /** Every mutation funnels through here so a failure surfaces instead of silently no-op'ing. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!task) {
    return (
      <aside className="flex w-[440px] shrink-0 items-center justify-center border-l border-ink-850 bg-ink-900">
        <p className="text-[13px] text-ink-500">{error ?? 'Loading…'}</p>
      </aside>
    );
  }

  const snoozed = task.snooze_until && new Date(task.snooze_until).getTime() > Date.now();

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-ink-850 bg-ink-900">
      <header className="flex items-center gap-2 border-b border-ink-850 px-4 py-3">
        <span className="font-mono text-[11px] text-ink-500">{task.ref}</span>
        <span
          className="rounded px-1.5 py-0.5 text-[11px]"
          style={{ background: `${task.project_color}22`, color: task.project_color }}
        >
          {task.project_key}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded px-2 py-1 text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-200"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {error && (
          <p className="rounded-md border border-p0/30 bg-p0/10 px-2.5 py-2 text-[12px] text-p0">
            {error}
          </p>
        )}

        <textarea
          value={titleDraft}
          rows={Math.max(1, Math.ceil(titleDraft.length / 44))}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            const next = titleDraft.trim();
            if (!next) {
              setTitleDraft(task.title); // an empty title is not a valid edit
              return;
            }
            if (next !== task.title) void act(() => api.patch(task.ref, { title: next }));
          }}
          className="w-full resize-none bg-transparent text-[16px] leading-snug font-medium
                     text-ink-50 outline-none"
        />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Status</span>
            <select
              value={task.status}
              onChange={(e) => void act(() => api.patch(task.ref, { status: e.target.value }))}
              className={`${field} mt-1`}
            >
              {COLUMNS.map((col) => (
                <option key={col.status} value={col.status}>
                  {col.label}
                </option>
              ))}
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div>
            <span className={label}>Priority</span>
            <div className="mt-1 flex gap-1">
              {[0, 1, 2, 3].map((p) => (
                <button
                  key={p}
                  onClick={() => void act(() => api.patch(task.ref, { priority: p }))}
                  style={{
                    color: task.priority === p ? PRIORITY_COLOR[p] : undefined,
                    borderColor: task.priority === p ? PRIORITY_COLOR[p] : undefined,
                  }}
                  className={`flex-1 rounded-md border py-1.5 text-[12px] transition-colors ${
                    task.priority === p
                      ? 'border bg-ink-850'
                      : 'border-ink-800 text-ink-500 hover:bg-ink-850'
                  }`}
                >
                  P{p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={label}>Project</span>
            <select
              value={task.project_key}
              onChange={(e) => void act(() => api.patch(task.ref, { project: e.target.value }))}
              className={`${field} mt-1`}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={label}>Assignee</span>
            <div className="mt-1 flex gap-1">
              <input
                defaultValue={task.assignee ?? ''}
                placeholder="unassigned"
                onBlur={(e) =>
                  void act(() => api.patch(task.ref, { assignee: e.target.value.trim() || null }))
                }
                className={field}
              />
              {task.assignee && (
                <button
                  onClick={() => void act(() => api.release(task.ref))}
                  className="shrink-0 rounded-md border border-ink-800 px-2 text-[12px]
                             text-ink-400 transition-colors hover:bg-ink-850"
                  title="Release the lease and return it to the queue"
                >
                  release
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Due</span>
            <input
              value={dueDraft}
              placeholder={task.due_at ? relativeTime(task.due_at) : 'friday, 3d, 2026-08-12'}
              onChange={(e) => setDueDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                void act(() => api.patch(task.ref, { due: dueDraft.trim() || null }));
                setDueDraft('');
              }}
              className={`${field} mt-1 ${task.due_at ? 'placeholder:text-ink-300' : ''}`}
            />
          </div>
          <div>
            <span className={label}>Snooze</span>
            <input
              value={snoozeDraft}
              placeholder={snoozed ? `until ${relativeTime(task.snooze_until!)}` : '3d, monday'}
              onChange={(e) => setSnoozeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                void act(() => api.patch(task.ref, { snooze: snoozeDraft.trim() || null }));
                setSnoozeDraft('');
              }}
              className={`${field} mt-1 ${snoozed ? 'placeholder:text-ink-300' : ''}`}
            />
          </div>
        </div>

        <div>
          <span className={label}>Repeats</span>
          <input
            defaultValue={task.recur ?? ''}
            placeholder="cron, e.g. 0 9 * * 1 for Mondays at 9am"
            onBlur={(e) => {
              if ((e.target.value.trim() || null) === task.recur) return;
              void act(() => api.patch(task.ref, { recur: e.target.value.trim() || null }));
            }}
            className={`${field} mt-1 font-mono`}
          />
          {task.recur && (
            <p className="mt-1 text-[11px] text-ink-500">
              Closing this creates the next occurrence automatically.
            </p>
          )}
        </div>

        <div>
          <span className={label}>Tags</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {task.tags.map((tag) => (
              <button
                key={tag}
                onClick={() => void act(() => api.patch(task.ref, { removeTags: [tag] }))}
                className="group rounded bg-ink-800 px-2 py-0.5 text-[12px] text-ink-300
                           transition-colors hover:bg-p0/15 hover:text-p0"
                title="Remove"
              >
                {tag}
                <span className="ml-1 opacity-0 transition-opacity group-hover:opacity-100">✕</span>
              </button>
            ))}
            <input
              value={tagDraft}
              placeholder="+ tag"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !tagDraft.trim()) return;
                void act(() => api.patch(task.ref, { addTags: [tagDraft.trim()] }));
                setTagDraft('');
              }}
              className="w-20 rounded bg-transparent px-1 py-0.5 text-[12px] text-ink-200
                         outline-none placeholder:text-ink-600"
            />
          </div>
        </div>

        <div>
          <span className={label}>Blocked by</span>
          <div className="mt-1 space-y-1">
            {task.blocked_by.map((ref) => (
              <div key={ref} className="flex items-center gap-2">
                <span className="rounded bg-p0/12 px-1.5 py-0.5 font-mono text-[12px] text-p0">
                  {ref}
                </span>
                <button
                  onClick={() => void act(() => api.removeDep(task.ref, ref))}
                  className="text-[11px] text-ink-600 transition-colors hover:text-ink-300"
                >
                  remove
                </button>
              </div>
            ))}
            <input
              value={depDraft}
              placeholder="+ blocker ref, e.g. demo-3"
              onChange={(e) => setDepDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !depDraft.trim()) return;
                void act(() => api.addDep(task.ref, depDraft.trim()));
                setDepDraft('');
              }}
              className={field}
            />
            {task.blocks.length > 0 && (
              <p className="pt-1 text-[11px] text-ink-500">
                Blocks {task.blocks.join(', ')}
              </p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className={label}>Description</span>
            <button
              onClick={() => {
                if (editingBody) void act(() => api.patch(task.ref, { body: draftBody }));
                setEditingBody(!editingBody);
              }}
              className="text-[11px] text-ink-500 transition-colors hover:text-accent"
            >
              {editingBody ? 'save' : 'edit'}
            </button>
          </div>
          {editingBody ? (
            <textarea
              value={draftBody}
              rows={10}
              autoFocus
              onChange={(e) => setDraftBody(e.target.value)}
              className={`${field} mt-1 resize-y font-mono text-[12px] leading-relaxed`}
            />
          ) : task.body.trim() ? (
            <div
              className="prose-orch mt-1 text-[13px] text-ink-200"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(task.body) }}
            />
          ) : (
            <p className="mt-1 text-[12px] text-ink-600">No description.</p>
          )}
        </div>

        <div>
          <span className={label}>Comments</span>
          <div className="mt-2 space-y-3">
            {task.comments.map((c) => (
              <div key={c.id} className="flex gap-2.5">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.kind === 'progress' ? 'bg-accent' : 'bg-ink-600'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-ink-100">{c.author}</span>
                    {c.kind === 'progress' && (
                      <span className="rounded bg-accent/12 px-1.5 text-[10px] tracking-wide text-accent uppercase">
                        agent
                      </span>
                    )}
                    <span className="text-[11px] text-ink-600">{relativeTime(c.created_at)}</span>
                  </div>
                  <div
                    className="prose-orch mt-0.5 text-[13px] break-words text-ink-300"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }}
                  />
                </div>
              </div>
            ))}
            {task.comments.length === 0 && (
              <p className="text-[12px] text-ink-600">No comments yet.</p>
            )}
          </div>

          <textarea
            value={comment}
            rows={2}
            placeholder="Leave a comment — ⌘↵ to post"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !comment.trim()) return;
              void act(() => api.comment(task.ref, comment));
              setComment('');
            }}
            className={`${field} mt-3 resize-none`}
          />
        </div>

        {task.events.length > 0 && (
          <div>
            <span className={label}>Activity</span>
            <div className="mt-2 space-y-1.5">
              {task.events.map((event) => (
                <EventLine key={event.id} event={event} showRef={false} />
              ))}
            </div>
          </div>
        )}

        <div className="border-t border-ink-850 pt-3">
          <button
            onClick={() => {
              if (confirm(`Delete ${task.ref}? This cannot be undone.`)) {
                void act(async () => {
                  await api.remove(task.ref);
                  onClose();
                });
              }
            }}
            className="text-[12px] text-ink-600 transition-colors hover:text-p0"
          >
            Delete task
          </button>
        </div>
      </div>
    </aside>
  );
}
