import {
  CalendarClock,
  CircleHelp,
  Clock3,
  FileText,
  Link2,
  MessageSquare,
  Pencil,
  Save,
  Send,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
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
import { PanelResizeHandle, useResizablePanel } from './components/ResizablePanel.tsx';
import { Button } from './components/ui/button.tsx';
import { cn } from './lib/utils.ts';
import { renderMarkdown } from './markdown.ts';

const label = 'text-[9.5px] font-semibold tracking-[0.09em] text-ink-600 uppercase';
const field =
  'h-9 w-full rounded-lg border border-white/[.065] bg-ink-950/60 px-3 text-[12px] text-ink-50 ' +
  'shadow-sm outline-none transition-all placeholder:text-ink-650 hover:border-white/10 ' +
  'focus:border-accent/45 focus:ring-3 focus:ring-accent/10';

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
  const [answerDraft, setAnswerDraft] = useState('');
  const [questionDraft, setQuestionDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
    setAsking(false);
    setConfirmingDelete(false);
    setQuestionDraft('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (asking) setAsking(false);
      else if (confirmingDelete) setConfirmingDelete(false);
      else if (!editingBody) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editingBody, asking, confirmingDelete]);

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

  const parkWithQuestion = async () => {
    if (!questionDraft.trim()) return;
    await act(() => api.ask(taskRef, questionDraft.trim()));
    setQuestionDraft('');
    setAsking(false);
  };

  const deleteTask = async () => {
    try {
      await api.remove(taskRef);
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const { panelStyle, handleProps } = useResizablePanel({
    storageKey: 'orchestration.task-panel-width',
    defaultWidth: 470,
    minWidth: 380,
    maxWidth: 720,
    mobileCap: 480,
  });

  if (!task) {
    return (
      <>
        <button aria-label="Close task" onClick={onClose} className="dialog-backdrop fixed inset-0 z-30 bg-black/50 xl:hidden" />
        <aside style={panelStyle} className="resizable-right-panel drawer-panel surface-shadow fixed inset-y-0 right-0 z-40 flex shrink-0 items-center justify-center border-l border-white/[.065] bg-ink-925/98 backdrop-blur-xl xl:relative">
          <PanelResizeHandle {...handleProps} label="Resize task details panel" />
          <div className="flex items-center gap-2 text-[12px] text-ink-500">
            {!error && <span className="size-4 animate-spin rounded-full border-2 border-ink-700 border-t-accent" />}
            {error ?? 'Loading task…'}
          </div>
        </aside>
      </>
    );
  }

  const snoozed = task.snooze_until && new Date(task.snooze_until).getTime() > Date.now();

  return (
    <>
      <button aria-label="Close task" onClick={onClose} className="dialog-backdrop fixed inset-0 z-30 bg-black/50 xl:hidden" />
      <aside style={panelStyle} className="resizable-right-panel drawer-panel surface-shadow fixed inset-y-0 right-0 z-40 flex shrink-0 flex-col border-l border-white/[.065] bg-ink-925/98 backdrop-blur-xl xl:relative">
      <PanelResizeHandle {...handleProps} label="Resize task details panel" />
      <header className="flex min-h-[72px] items-center gap-2.5 border-b border-white/[.055] px-4">
        <span className="font-mono text-[10px] tracking-wide text-ink-500">{task.ref}</span>
        <span
          className="rounded-md border px-1.5 py-0.5 text-[9.5px] font-medium"
          style={{
            background: `${task.project_color}18`,
            borderColor: `${task.project_color}30`,
            color: task.project_color,
          }}
        >
          {task.project_key}
        </span>
        <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto" title="Close (Esc)">
          <X />
          <span className="sr-only">Close task</span>
        </Button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {error && (
          <p className="rounded-lg border border-p0/20 bg-p0/[.08] px-3 py-2 text-[11px] text-p0">
            {error}
          </p>
        )}

        {task.question && (
          <section className="rounded-xl border border-status-input/20 bg-status-input/[.06] p-3.5 shadow-[0_12px_35px_-28px_rgba(240,129,177,.8)]">
            <div className="flex items-center gap-2 text-status-input">
              <span className="grid size-7 place-items-center rounded-lg bg-status-input/10">
                <CircleHelp className="size-3.5" />
              </span>
              <p className="text-[9.5px] font-semibold tracking-[0.09em] uppercase">
                {task.question_from ?? 'An agent'} is waiting on you
              </p>
            </div>
            <div
              className="prose-orchestration mt-2.5 text-[12px] text-ink-100"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(task.question) }}
            />
            <textarea
              value={answerDraft}
              rows={3}
              autoFocus
              placeholder="Your answer — ⌘↵ to send it back to the queue"
              onChange={(e) => setAnswerDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !answerDraft.trim()) return;
                void act(() => api.answer(task.ref, answerDraft));
                setAnswerDraft('');
              }}
              className={cn(field, 'mt-2.5 h-auto resize-none py-2.5 leading-relaxed focus:border-status-input/50 focus:ring-status-input/10')}
            />
            <Button
              onClick={() => {
                if (!answerDraft.trim()) return;
                void act(() => api.answer(task.ref, answerDraft));
                setAnswerDraft('');
              }}
              disabled={!answerDraft.trim()}
              size="sm"
              className="mt-2 bg-status-input text-ink-950 shadow-none hover:bg-status-input/90"
            >
              <Send /> Answer and unblock
            </Button>
          </section>
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
          className="w-full resize-none bg-transparent text-[18px] leading-[1.35] font-semibold
                     tracking-[-0.015em] text-ink-50 outline-none placeholder:text-ink-650"
        />

        <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/[.05] bg-white/[.018] p-3">
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
            <div className="mt-1 flex h-9 gap-1 rounded-lg border border-white/[.065] bg-ink-950/60 p-1">
              {[0, 1, 2, 3].map((p) => (
                <button
                  key={p}
                  onClick={() => void act(() => api.patch(task.ref, { priority: p }))}
                  style={{
                    color: task.priority === p ? PRIORITY_COLOR[p] : undefined,
                  }}
                  className={`flex-1 rounded-md text-[10.5px] font-medium transition-colors ${
                    task.priority === p
                      ? 'bg-white/[.075] shadow-sm'
                      : 'text-ink-600 hover:bg-white/[.035] hover:text-ink-400'
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
            <span className={cn(label, 'flex items-center gap-1.5')}><UserRound className="size-3" />Assignee</span>
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
                <Button
                  onClick={() => void act(() => api.release(task.ref))}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  title="Release the lease and return it to the queue"
                >
                  release
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={cn(label, 'flex items-center gap-1.5')}><CalendarClock className="size-3" />Due</span>
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
            <span className={cn(label, 'flex items-center gap-1.5')}><Clock3 className="size-3" />Snooze</span>
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
          <span className={cn(label, 'flex items-center gap-1.5')}><CalendarClock className="size-3" />Repeats</span>
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
            <p className="mt-1.5 text-[10px] text-ink-600">
              Closing this creates the next occurrence automatically.
            </p>
          )}
        </div>

        <div>
          <span className={cn(label, 'flex items-center gap-1.5')}><Tag className="size-3" />Tags</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-white/[.05] bg-white/[.018] p-2">
            {task.tags.map((tag) => (
              <button
                key={tag}
                onClick={() => void act(() => api.patch(task.ref, { removeTags: [tag] }))}
                className="group rounded-md border border-white/[.055] bg-white/[.04] px-2 py-1 text-[10.5px] text-ink-400
                           transition-colors hover:border-p0/20 hover:bg-p0/10 hover:text-p0"
                title="Remove"
              >
                #{tag}
                <X className="ml-1 inline size-2.5 opacity-0 transition-opacity group-hover:opacity-100" />
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
              className="min-w-20 flex-1 rounded bg-transparent px-1 py-1 text-[11px] text-ink-200
                         outline-none placeholder:text-ink-650"
            />
          </div>
        </div>

        <div>
          <span className={cn(label, 'flex items-center gap-1.5')}><Link2 className="size-3" />Blocked by</span>
          <div className="mt-1.5 space-y-1.5">
            {task.blocked_by.map((ref) => (
              <div key={ref} className="flex items-center gap-2">
                <span className="rounded-md border border-p0/15 bg-p0/[.08] px-2 py-1 font-mono text-[10.5px] text-p0">
                  {ref}
                </span>
                <button
                  onClick={() => void act(() => api.removeDep(task.ref, ref))}
                  className="text-[10px] text-ink-650 transition-colors hover:text-ink-300"
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
              <p className="pt-1 text-[10px] text-ink-600">
                Blocks {task.blocks.join(', ')}
              </p>
            )}
          </div>
        </div>

        <section className="rounded-xl border border-white/[.05] bg-white/[.018] p-3">
          <div className="flex items-center justify-between">
            <span className={cn(label, 'flex items-center gap-1.5')}><FileText className="size-3" />Description</span>
            <button
              onClick={() => {
                if (editingBody) void act(() => api.patch(task.ref, { body: draftBody }));
                setEditingBody(!editingBody);
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-ink-600 transition-colors hover:bg-white/[.04] hover:text-accent-soft"
            >
              {editingBody ? <><Save className="size-3" />save</> : <><Pencil className="size-3" />edit</>}
            </button>
          </div>
          {editingBody ? (
            <textarea
              value={draftBody}
              rows={10}
              autoFocus
              onChange={(e) => setDraftBody(e.target.value)}
              className={cn(field, 'mt-2 h-auto min-h-48 resize-y py-2.5 font-mono text-[11px] leading-relaxed')}
            />
          ) : task.body.trim() ? (
            <div
              className="prose-orchestration mt-2 text-[12px] text-ink-300"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(task.body) }}
            />
          ) : (
            <p className="mt-2 text-[11px] text-ink-650">No description yet.</p>
          )}
        </section>

        <section>
          <span className={cn(label, 'flex items-center gap-1.5')}><MessageSquare className="size-3" />Comments</span>
          <div className="mt-2.5 space-y-2">
            {task.comments.map((c) => (
              <div key={c.id} className="flex gap-2.5 rounded-lg border border-white/[.045] bg-white/[.018] p-2.5">
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-lg text-[9px] font-semibold ${
                    c.kind === 'question'
                      ? 'bg-status-input/10 text-status-input'
                      : c.kind === 'answer'
                        ? 'bg-status-done/10 text-status-done'
                        : c.kind === 'progress'
                          ? 'bg-accent/10 text-accent-soft'
                          : 'bg-white/[.05] text-ink-500'
                  }`}
                >
                  {c.author.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] font-medium text-ink-100">{c.author}</span>
                    {c.kind === 'progress' && (
                      <span className="rounded bg-accent/10 px-1.5 text-[8.5px] tracking-wide text-accent-soft uppercase">
                        agent
                      </span>
                    )}
                    {c.kind === 'question' && (
                      <span className="rounded bg-status-input/10 px-1.5 text-[8.5px] tracking-wide text-status-input uppercase">
                        asked
                      </span>
                    )}
                    {c.kind === 'answer' && (
                      <span className="rounded bg-status-done/10 px-1.5 text-[8.5px] tracking-wide text-status-done uppercase">
                        answered
                      </span>
                    )}
                    <span className="ml-auto text-[9px] text-ink-650">{relativeTime(c.created_at)}</span>
                  </div>
                  <div
                    className="prose-orchestration mt-1 text-[11.5px] break-words text-ink-400"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }}
                  />
                </div>
              </div>
            ))}
            {task.comments.length === 0 && (
              <p className="rounded-lg border border-dashed border-white/[.05] py-5 text-center text-[10.5px] text-ink-650">No comments yet.</p>
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
            className={cn(field, 'mt-2.5 h-auto resize-none py-2.5 leading-relaxed')}
          />
        </section>

        {task.events.length > 0 && (
          <section>
            <span className={cn(label, 'flex items-center gap-1.5')}><Clock3 className="size-3" />Activity</span>
            <div className="mt-2 space-y-1.5">
              {task.events.map((event) => (
                <EventLine key={event.id} event={event} showRef={false} />
              ))}
            </div>
          </section>
        )}

        {asking && (
          <section className="rounded-xl border border-status-input/18 bg-status-input/[.055] p-3">
            <div className="flex items-center gap-2 text-status-input">
              <CircleHelp className="size-3.5" />
              <p className="text-[10px] font-semibold">What decision is needed?</p>
            </div>
            <textarea
              value={questionDraft}
              onChange={(event) => setQuestionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void parkWithQuestion();
              }}
              rows={3}
              autoFocus
              placeholder="Ask one specific question with the options you see…"
              className={cn(field, 'mt-2 h-auto resize-none py-2.5 leading-relaxed focus:border-status-input/50 focus:ring-status-input/10')}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
              <Button
                size="sm"
                disabled={!questionDraft.trim()}
                onClick={() => void parkWithQuestion()}
                className="bg-status-input text-ink-950 shadow-none hover:bg-status-input/90"
              >
                <Send /> Park task
              </Button>
            </div>
          </section>
        )}

        {confirmingDelete && (
          <section className="rounded-xl border border-p0/20 bg-p0/[.055] p-3">
            <div className="flex gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-p0/10 text-p0"><Trash2 className="size-3.5" /></span>
              <div>
                <p className="text-[11px] font-medium text-ink-100">Delete {task.ref}?</p>
                <p className="mt-0.5 text-[10px] text-ink-600">This permanently removes the task and its history.</p>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => void deleteTask()}><Trash2 /> Delete permanently</Button>
            </div>
          </section>
        )}

        <div className="flex items-center gap-2 border-t border-white/[.055] pt-4">
          {!task.question && task.status !== 'done' && task.status !== 'cancelled' && (
            <Button
              onClick={() => {
                setAsking(true);
                setConfirmingDelete(false);
              }}
              variant="ghost"
              size="sm"
              className="text-ink-600 hover:text-status-input"
            >
              <CircleHelp /> Park with a question
            </Button>
          )}
          <Button
            onClick={() => {
              setConfirmingDelete(true);
              setAsking(false);
            }}
            variant="ghost"
            size="sm"
            className="ml-auto text-ink-650 hover:bg-p0/10 hover:text-p0"
          >
            <Trash2 /> Delete task
          </Button>
        </div>
      </div>
      </aside>
    </>
  );
}
