import type { Comment, EventView, TaskView } from '../core/index.ts';
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

  if (task.blocked_by.length) {
    out.push(c.red(`blocked by ${task.blocked_by.join(', ')}`));
  }
  if (task.blocks.length) out.push(c.dim(`blocks ${task.blocks.join(', ')}`));

  if (task.body.trim()) out.push('', task.body.trim());

  if (comments.length) {
    out.push('', c.bold('Comments'));
    for (const comment of comments) {
      const badge = comment.kind === 'progress' ? c.cyan('[progress]') : '';
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
