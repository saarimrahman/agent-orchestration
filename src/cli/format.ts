import type {
  Comment,
  EventView,
  MemoryContext,
  MemoryBacklink,
  MemoryDocument,
  MemoryGraph,
  MemoryLintIssue,
  MemorySearchResult,
  RetrievalEvaluation,
  TaskView,
} from '../core/index.ts';
import { relative } from '../core/index.ts';

const enabled =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const code = (n: string) => (s: string) => (enabled ? `\x1b[${n}m${s}\x1b[0m` : s);

export const c = {
  dim: code('2'),
  bold: code('1'),
  red: code('31'),
  green: code('32'),
  yellow: code('33'),
  blue: code('34'),
  magenta: code('35'),
  cyan: code('36'),
  gray: code('90'),
};

const STATUS_COLOR: Record<string, (s: string) => string> = {
  backlog: c.gray,
  ready: c.cyan,
  in_progress: c.yellow,
  needs_input: c.magenta,
  review: c.magenta,
  done: c.green,
  cancelled: c.gray,
};

const PRIORITY_COLOR = [c.red, c.yellow, c.blue, c.gray];

/** Visible width, ignoring ANSI escapes. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, to: number): string {
  return s + ' '.repeat(Math.max(0, to - width(s)));
}

export function formatDue(task: TaskView, now = new Date()): string {
  if (!task.due_at) return '';
  const overdue = new Date(task.due_at).getTime() <= now.getTime();
  const text = relative(task.due_at, now);
  return overdue ? c.red(text) : c.dim(text);
}

/** One task per line, columns aligned. */
export function taskTable(tasks: TaskView[]): string {
  if (!tasks.length) return c.dim('No tasks.');

  const rows = tasks.map((t) => {
    const blocked = t.blocked_by.length ? c.red(`blocked:${t.blocked_by.length}`) : '';
    const tags = t.tags.length ? c.dim(t.tags.map((x) => `#${x}`).join(' ')) : '';
    const who = t.assignee ? c.dim(`@${t.assignee}`) : '';
    return [
      c.bold(t.ref),
      PRIORITY_COLOR[t.priority](`P${t.priority}`),
      (STATUS_COLOR[t.status] ?? c.gray)(t.status),
      t.title,
      [formatDue(t), who, tags, blocked].filter(Boolean).join(' '),
    ];
  });

  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => width(r[i]))));
  return rows
    .map((r) =>
      [pad(r[0], widths[0]), pad(r[1], widths[1]), pad(r[2], widths[2]), pad(r[3], widths[3]), r[4]]
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function taskDetail(
  task: TaskView,
  comments: Comment[],
  events: EventView[],
  memory?: MemoryContext,
): string {
  const out: string[] = [];
  out.push(`${c.bold(task.ref)}  ${task.title}`);

  const meta = [
    `${(STATUS_COLOR[task.status] ?? c.gray)(task.status)}`,
    PRIORITY_COLOR[task.priority](`P${task.priority}`),
    c.dim(task.project_key),
  ];
  if (task.assignee) meta.push(c.dim(`@${task.assignee}`));
  if (task.tags.length) meta.push(c.dim(task.tags.map((t) => `#${t}`).join(' ')));
  out.push(meta.join('  '));

  const times: string[] = [];
  if (task.due_at) times.push(`due ${formatDue(task)}`);
  if (task.snooze_until && task.snooze_until > new Date().toISOString()) {
    times.push(c.dim(`snoozed until ${relative(task.snooze_until)}`));
  }
  if (task.recur) times.push(c.dim(`repeats "${task.recur}"`));
  if (task.lease_expires_at && task.status === 'in_progress') {
    const expired = task.lease_expires_at <= new Date().toISOString();
    times.push(
      expired
        ? c.red(`lease expired ${relative(task.lease_expires_at)}`)
        : c.dim(`lease ends ${relative(task.lease_expires_at)}`),
    );
  }
  if (times.length) out.push(times.join('  '));

  if (task.question) {
    out.push('', c.magenta(`${task.question_from ?? 'An agent'} is waiting on you:`));
    for (const line of task.question.split('\n')) out.push(`  ${line}`);
    out.push(c.dim(`  answer with: orchestration answer ${task.ref} "..."`));
  }

  if (task.blocked_by.length) {
    out.push(c.red(`blocked by ${task.blocked_by.join(', ')}`));
  }
  if (task.blocks.length) out.push(c.dim(`blocks ${task.blocks.join(', ')}`));

  if (task.body.trim()) out.push('', task.body.trim());

  if (memory && (memory.pinned.length || memory.matches.length)) {
    out.push('', memoryContextText(memory));
  }

  if (comments.length) {
    out.push('', c.bold('Comments'));
    const badges: Record<string, string> = {
      progress: c.cyan('[progress]'),
      question: c.magenta('[asked]'),
      answer: c.green('[answered]'),
    };
    for (const comment of comments) {
      const badge = badges[comment.kind] ?? '';
      out.push(
        `  ${c.bold(comment.author)} ${badge} ${c.dim(relative(comment.created_at))}`.trimEnd(),
      );
      for (const line of comment.body.split('\n')) out.push(`    ${line}`);
    }
  }

  if (events.length) {
    out.push('', c.bold('Activity'));
    for (const event of events.slice(-12)) {
      out.push(`  ${c.dim(relative(event.at).padEnd(9))} ${describeEvent(event)}`);
    }
  }

  return out.join('\n');
}

export function memoryContextText(memory: MemoryContext): string {
  const out = [c.bold('Relevant memory')];
  for (const pinned of memory.pinned) {
    out.push(`  ${c.magenta(`[${pinned.scope} guidance]`)} ${c.dim(pinned.path)}`);
    for (const line of pinned.body.split('\n')) out.push(`    ${line}`);
  }
  for (const match of memory.matches) {
    out.push(
      `  ${c.cyan(`[${match.kind}]`)} ${c.bold(match.title)} ${c.dim(match.id.slice(0, 12))}`,
    );
    if (match.snippet) out.push(`    ${match.snippet.replace(/\s+/g, ' ').trim()}`);
    const source = match.sources.length ? ` · source ${match.sources.join(', ')}` : '';
    out.push(c.dim(`    ${match.path}${source}`));
  }
  return out.join('\n');
}

export function memoryTable(memories: MemoryDocument[]): string {
  if (!memories.length) return c.dim('No memories.');
  return memories.map((memory) => {
    const scope = memory.scope === 'global' ? 'global' : (memory.project_key ?? 'project');
    const tags = memory.tags.length ? c.dim(memory.tags.map((tag) => `#${tag}`).join(' ')) : '';
    return [
      c.bold(memory.id.slice(0, 12).padEnd(12)),
      c.cyan(memory.kind.padEnd(10)),
      (memory.status === 'active' ? c.green : c.yellow)(memory.status.padEnd(10)),
      c.dim(scope.padEnd(12)),
      memory.title,
      tags,
    ].filter(Boolean).join('  ');
  }).join('\n');
}

export function memorySearchTable(memories: MemorySearchResult[], explain = false): string {
  if (!explain) return memoryTable(memories);
  if (!memories.length) return c.dim('No memories.');
  return memories.map((memory) => [
    memoryTable([memory]),
    `  ${c.dim(memory.explanation)}`,
    memory.snippet ? `  ${memory.snippet.replace(/\s+/g, ' ').trim()}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

export function memoryDetail(memory: MemoryDocument): string {
  const out = [
    `${c.bold(memory.id)}  ${memory.title}`,
    `${c.cyan(memory.kind)}  ${memory.status === 'active' ? c.green(memory.status) : c.yellow(memory.status)}  ${c.dim(memory.scope === 'global' ? 'global' : (memory.project_key ?? 'project'))}`,
    c.dim(memory.path),
  ];
  if (memory.aliases.length) out.push(c.dim(`aliases: ${memory.aliases.join(', ')}`));
  if (memory.tags.length) out.push(c.dim(memory.tags.map((tag) => `#${tag}`).join(' ')));
  if (memory.sources.length) out.push(c.dim(`sources: ${memory.sources.join(', ')}`));
  if (memory.relations.length) {
    out.push('', c.bold('Relations'));
    for (const relation of memory.relations) {
      out.push(`  ${c.cyan(relation.type)} ${c.dim(relation.target_type)} ${relation.target}`);
    }
  }
  out.push('', memory.body);
  return out.join('\n');
}

export function memoryBacklinkTable(backlinks: MemoryBacklink[]): string {
  if (!backlinks.length) return c.dim('No backlinks.');
  return backlinks.map((backlink) => [
    c.bold(backlink.source.id.slice(0, 12)),
    backlink.source.title,
    c.cyan(backlink.type),
    c.dim(`${backlink.target_type}:${backlink.target}`),
  ].join('  ')).join('\n');
}

export function memoryGraphText(graph: MemoryGraph): string {
  const titleById = new Map(graph.memories.map((memory) => [memory.id, memory.title]));
  const out = [c.bold(`Memory graph · ${graph.memories.length} nodes · ${graph.relations.length} edges`)];
  for (const memory of graph.memories) {
    out.push(`  ${c.bold(memory.id.slice(0, 12))}  ${memory.title}`);
  }
  if (graph.relations.length) out.push('', c.bold('Edges'));
  for (const relation of graph.relations) {
    const target = relation.target_type === 'memory'
      ? (titleById.get(relation.target) ?? relation.target)
      : `${relation.target_type}:${relation.target}`;
    out.push(`  ${relation.source_id.slice(0, 12)} ${c.cyan(relation.type)} ${target}`);
  }
  if (graph.truncated) out.push('', c.yellow('Graph truncated; increase --limit to include more nodes.'));
  return out.join('\n');
}

export function memoryLintText(issues: MemoryLintIssue[]): string {
  if (!issues.length) return c.green('Memory lint passed.');
  return issues.map((issue) => {
    const severity = issue.severity === 'error' ? c.red(issue.severity) : c.yellow(issue.severity);
    return `${severity}  ${c.bold(issue.memory_id.slice(0, 12))}  ${issue.code}  ${issue.message}`;
  }).join('\n');
}

export function memorySuggestions(
  source: MemoryDocument,
  suggestions: MemorySearchResult[],
  explain = false,
): string {
  if (!suggestions.length) return c.dim(`No unlinked suggestions for ${source.title}.`);
  return [
    c.bold(`Suggested links for ${source.title}`),
    ...suggestions.flatMap((memory) => [
      `  ${c.bold(memory.id.slice(0, 12))}  ${memory.title}  ${c.dim(`score ${memory.score.toFixed(3)}`)}`,
      ...(explain ? [`    ${c.dim(memory.explanation)}`] : []),
    ]),
  ].join('\n');
}

export function memoryEvaluationText(evaluation: RetrievalEvaluation): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const out = [
    c.bold(`Memory retrieval evaluation · k=${evaluation.k} · ${evaluation.cases.length} cases`),
    `Recall@${evaluation.k} ${c.cyan(percent(evaluation.recall_at_k))}  ` +
      `MRR ${c.cyan(evaluation.mrr.toFixed(3))}  ` +
      `precision ${c.cyan(percent(evaluation.context_precision))}  ` +
      `stale hits ${evaluation.stale_hit_rate ? c.yellow(percent(evaluation.stale_hit_rate)) : c.green('0.0%')}`,
  ];
  if (evaluation.cases.length) out.push('', c.bold('Cases'));
  for (const item of evaluation.cases) {
    out.push(
      `  ${c.bold(item.name)}  recall ${percent(item.recall_at_k)}  ` +
      `RR ${item.reciprocal_rank.toFixed(3)}  precision ${percent(item.context_precision)}  ` +
      `stale ${item.stale_hits}`,
    );
    out.push(c.dim(`    ${item.retrieved.length ? item.retrieved.join(', ') : 'no results'}`));
  }
  return out.join('\n');
}

export function describeEvent(event: EventView): string {
  const who = c.bold(event.actor);
  switch (event.field) {
    case 'created':
      return `${who} created it`;
    case 'status':
      return `${who} moved ${c.dim(event.old_value ?? '?')} → ${(
        STATUS_COLOR[event.new_value ?? ''] ?? c.gray
      )(event.new_value ?? '?')}`;
    case 'claimed':
      return `${who} claimed it`;
    case 'released':
      return `${who} released it`;
    case 'progress':
      return `${who} reported: ${truncate(event.new_value ?? '', 70)}`;
    case 'comment':
      return `${who} commented: ${truncate(event.new_value ?? '', 70)}`;
    case 'question':
      return `${who} ${c.magenta('asked')}: ${truncate(event.new_value ?? '', 70)}`;
    case 'answer':
      return `${who} ${c.green('answered')}: ${truncate(event.new_value ?? '', 70)}`;
    case 'recurred_from':
      return `${who} rolled over from ${event.old_value}`;
    case 'deleted':
      return `${who} deleted ${event.old_value}`;
    default:
      return `${who} set ${event.field} ${c.dim(`${event.old_value ?? '∅'} → ${event.new_value ?? '∅'}`)}`;
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
