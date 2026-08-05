import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LEASE_MS,
  WORKFLOW,
  addComment,
  addDep,
  answerInput,
  archiveProject,
  askForInput,
  attachTag,
  awaitingInput,
  claimNext,
  claimTask,
  createProject,
  createTask,
  deleteTask,
  detachTag,
  digest,
  endOfLocalDay,
  isValidCron,
  listComments,
  listEvents,
  listProjects,
  listTags,
  listTasks,
  mergeAgentsFile,
  openDb,
  parseDuration,
  parseWhenOrThrow,
  readyTasks,
  recentEvents,
  releaseTask,
  removeDep,
  requireTask,
  resolveDbPath,
  setStatus,
  skillFile,
  updateTask,
  STATUSES,
  type Db,
  type Status,
  type TaskView,
} from '../core/index.ts';

import { bool, list, num, parseArgs, present, str, type Parsed } from './args.ts';
import { c, describeEvent, json, taskDetail, taskTable } from './format.ts';

const HELP = `orch — a local to-do queue that agents can read, claim, and report to.

Usage: orch <command> [options]

Queue
  ready                     Everything claimable right now
  next [--claim]            The top of the queue, optionally taken atomically
  claim <ref>               Take a specific task
  release <ref>             Put a held task back
  digest                    Waiting on you, overdue, due today, ready, in progress

Waiting on a human
  ask <ref> "<question>"    Hand the task back with a question (agents use this)
  answer <ref> "<answer>"   Answer it and return the task to the queue
  inbox                     Everything currently waiting on you

Tasks
  add "<title>"             Create a task
  ls                        List open tasks
  show <ref>                Full detail, comments, and history
  edit <ref>                Change title, body, priority, due date, project…
  comment <ref> "<text>"    Leave a note (--progress marks it an agent update)
  start|review|done|cancel <ref> ["note"]
  snooze <ref> <when>       Defer until later
  rm <ref>                  Delete

Structure
  dep add|rm <ref> <blocker-ref>
  tag add|rm <ref> <tag>
  tags                      Tags in use
  project add|ls|archive|unarchive [key]

Other
  init [--project <key>]    Create the database and write agent instructions
  instructions              Print the agent workflow
  ui [--port 4477]          Open the board in a browser
  ui --host                 Also serve on the network (prints an access token)
  where                     Print the database path

Common options
  -p, --project <key>   -P, --priority 0-3   -t, --tag <name>
  -d, --due <when>      -a, --agent <name>   -m, --message <text>
  -j, --json            --limit <n>          --recur "<cron>"

Times accept durations (3d, 2h), dates (2026-08-12), or plain English ("friday").
Every read command supports --json.`;

class CliError extends Error {}

function actor(p: Parsed): string {
  return (
    str(p, 'agent') ??
    str(p, 'as') ??
    process.env.ORCH_ACTOR ??
    process.env.ORCH_AGENT ??
    userInfo().username
  );
}

/**
 * Who to credit for an action on a task already in hand. Falls back to the
 * current assignee before the OS user, so an agent that claimed as `bruno` and
 * then ran `orch ask` without repeating `--agent` is still recorded as bruno
 * rather than as whoever owns the shell.
 */
function actorFor(p: Parsed, task: TaskView): string {
  return (
    str(p, 'agent') ??
    str(p, 'as') ??
    process.env.ORCH_ACTOR ??
    process.env.ORCH_AGENT ??
    task.assignee ??
    userInfo().username
  );
}

function leaseMs(p: Parsed): number {
  const raw = str(p, 'ttl');
  if (!raw) return DEFAULT_LEASE_MS;
  const ms = parseDuration(raw);
  if (ms === null) throw new CliError(`--ttl needs a duration like 30m, 2h, or 1d. Got "${raw}".`);
  return ms;
}

function statusList(p: Parsed): Status[] | undefined {
  const raw = list(p, 'status');
  if (!raw.length) return undefined;
  for (const s of raw) {
    if (!STATUSES.includes(s as Status)) {
      throw new CliError(`Unknown status "${s}". Valid: ${STATUSES.join(', ')}.`);
    }
  }
  return raw as Status[];
}

function out(p: Parsed, value: unknown, text: () => string): void {
  console.log(bool(p, 'json') ? json(value) : text());
}

/** Print a task the way the rest of the CLI does, so agents see a stable shape. */
function emitTask(p: Parsed, task: TaskView, note?: string): void {
  if (bool(p, 'json')) {
    console.log(json(task));
    return;
  }
  console.log(`${c.bold(task.ref)}  ${task.title}${note ? c.dim(`  (${note})`) : ''}`);
}

// ------------------------------------------------------------------ commands

function cmdInit(db: Db, p: Parsed): void {
  const key = str(p, 'project') ?? 'general';
  const existing = listProjects(db, true);
  const project = existing.find((x) => x.key === key) ?? createProject(db, key);

  const root = process.cwd();
  const written: string[] = [];

  const skillPath = join(root, '.claude', 'skills', 'orch', 'SKILL.md');
  if (!existsSync(skillPath) || bool(p, 'force')) {
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, skillFile());
    written.push(skillPath);
  }

  const agentsPath = join(root, 'AGENTS.md');
  const current = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  writeFileSync(agentsPath, mergeAgentsFile(current));
  written.push(agentsPath);

  out(p, { db: resolveDbPath(), project, written }, () =>
    [
      `Database  ${resolveDbPath()}`,
      `Project   ${project.key}`,
      ...written.map((f) => `Wrote     ${f.replace(`${root}/`, '')}`),
      '',
      `Add your first task:  ${c.bold(`orch add "Something to do" -p ${project.key}`)}`,
      `Open the board:       ${c.bold('orch ui')}`,
    ].join('\n'),
  );
}

function cmdAdd(db: Db, p: Parsed): void {
  const title = p.positional.join(' ').trim();
  if (!title) throw new CliError('What should the task be called?  orch add "Fix the parser"');

  const recur = str(p, 'recur');
  if (recur && !isValidCron(recur)) {
    throw new CliError(
      `--recur needs a 5-field cron expression. "0 9 * * 1" is every Monday at 9am.`,
    );
  }

  const due = str(p, 'due');
  const snooze = str(p, 'snooze');

  const task = createTask(db, {
    title,
    project: str(p, 'project'),
    body: str(p, 'body'),
    priority: num(p, 'priority'),
    status: str(p, 'status') as Status | undefined,
    assignee: str(p, 'assign'),
    dueAt: due ? parseWhenOrThrow(due) : null,
    snoozeUntil: snooze ? parseWhenOrThrow(snooze) : null,
    recur: recur ?? null,
    tags: list(p, 'tag'),
    dependsOn: list(p, 'dep'),
    actor: actor(p),
  });

  emitTask(p, task, 'created');
}

function cmdLs(db: Db, p: Parsed): void {
  const dueRaw = str(p, 'due');
  const tasks = listTasks(db, {
    project: str(p, 'project'),
    status: statusList(p),
    tag: str(p, 'tag'),
    assignee: str(p, 'assignee') ?? str(p, 'agent'),
    dueBefore: dueRaw
      ? dueRaw === 'today'
        ? endOfLocalDay()
        : parseWhenOrThrow(dueRaw).toISOString()
      : undefined,
    search: str(p, 'search') ?? (p.positional.join(' ').trim() || undefined),
    includeClosed: bool(p, 'all') || bool(p, 'closed'),
    limit: num(p, 'limit'),
  });
  out(p, tasks, () => taskTable(tasks));
}

function cmdReady(db: Db, p: Parsed): void {
  const tasks = readyTasks(db, {
    project: str(p, 'project'),
    tag: str(p, 'tag'),
    limit: num(p, 'limit'),
  });
  out(p, tasks, () => taskTable(tasks));
}

function cmdNext(db: Db, p: Parsed): number {
  const options = {
    project: str(p, 'project'),
    tag: str(p, 'tag'),
    leaseMs: leaseMs(p),
  };

  const task = bool(p, 'claim')
    ? claimNext(db, actor(p), options)
    : (readyTasks(db, { ...options, limit: 1 })[0] ?? null);

  if (!task) {
    // Exit 1 on an empty queue so a polling loop can branch on it without parsing.
    if (bool(p, 'json')) console.log(json(null));
    else console.error(c.dim('Queue is empty.'));
    return 1;
  }

  if (bool(p, 'json')) console.log(json(task));
  else console.log(taskDetail(task, listComments(db, task.id), []));
  return 0;
}

function cmdClaim(db: Db, p: Parsed): number {
  const task = requireTask(db, requirePositional(p, 0, 'orch claim <ref>'));
  const claimed = claimTask(db, task.id, actor(p), leaseMs(p));

  if (!claimed) {
    const current = requireTask(db, task.ref);
    throw new CliError(
      current.blocked_by.length
        ? `${task.ref} is blocked by ${current.blocked_by.join(', ')}.`
        : current.assignee
          ? `${task.ref} is already held by ${current.assignee}. Try "orch next --claim".`
          : `${task.ref} is not claimable (status: ${current.status}).`,
    );
  }
  emitTask(p, claimed, `claimed by ${claimed.assignee}`);
  return 0;
}

function cmdRelease(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch release <ref>'));
  emitTask(p, releaseTask(db, task.id, actor(p)), 'released');
}

function cmdShow(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch show <ref>'));
  const comments = listComments(db, task.id);
  const events = listEvents(db, task.id);
  out(p, { ...task, comments, events }, () => taskDetail(task, comments, events));
}

function cmdComment(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch comment <ref> "<text>"'));
  const body = str(p, 'message') ?? p.positional.slice(1).join(' ');
  if (!body.trim()) throw new CliError('What should the comment say?');

  const comment = addComment(
    db,
    task.id,
    actorFor(p, task),
    body,
    bool(p, 'progress') ? 'progress' : 'note',
  );
  out(p, comment, () => `${c.dim('commented on')} ${c.bold(task.ref)}`);
}

function cmdStatus(db: Db, p: Parsed, status: Status): void {
  const task = requireTask(db, requirePositional(p, 0, `orch ${status} <ref>`));
  const note = str(p, 'message') ?? p.positional.slice(1).join(' ');
  const who = actorFor(p, task);
  if (note.trim()) addComment(db, task.id, who, note, 'progress');

  const { task: updated, recurrence } = setStatus(db, task.id, status, who);
  out(p, { task: updated, recurrence }, () => {
    const lines = [`${c.bold(updated.ref)} → ${status}`];
    if (recurrence) {
      lines.push(
        c.dim(`next occurrence ${recurrence.ref} due ${recurrence.due_at?.slice(0, 10)}`),
      );
    }
    const unblocked = updated.blocks
      .map((ref) => requireTask(db, ref))
      .filter((t) => t.blocked_by.length === 0 && !['done', 'cancelled'].includes(t.status));
    if (unblocked.length) {
      lines.push(c.dim(`unblocked ${unblocked.map((t) => t.ref).join(', ')}`));
    }
    return lines.join('\n');
  });
}

function cmdAsk(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch ask <ref> "<question>"'));
  const question = str(p, 'message') ?? p.positional.slice(1).join(' ');
  if (!question.trim()) {
    throw new CliError('What do you need to know?  orch ask demo-3 "Which auth flow?"');
  }

  const { task: updated } = askForInput(db, task.id, actorFor(p, task), question);
  out(p, updated, () =>
    [
      `${c.bold(updated.ref)} → ${c.magenta('needs_input')}`,
      c.dim('Waiting on a human. It has left the queue and the lease is released.'),
    ].join('\n'),
  );
}

function cmdAnswer(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch answer <ref> "<answer>"'));
  const answer = str(p, 'message') ?? p.positional.slice(1).join(' ');
  if (!answer.trim()) throw new CliError('What is the answer?');

  const { task: updated } = answerInput(db, task.id, actor(p), answer);
  out(p, updated, () =>
    `${c.bold(updated.ref)} → ${updated.status}${
      updated.status === 'ready' ? c.dim('  (back on the queue)') : ''
    }`,
  );
}

function cmdAsking(db: Db, p: Parsed): void {
  const tasks = awaitingInput(db, str(p, 'project'));
  out(p, tasks, () => {
    if (!tasks.length) return c.dim('Nothing is waiting on you.');
    return tasks
      .map((t) =>
        [
          `${c.bold(t.ref)}  ${t.title}`,
          `  ${c.magenta(t.question_from ?? 'agent')} asks: ${t.question ?? ''}`,
          c.dim(`  answer with: orch answer ${t.ref} "..."`),
        ].join('\n'),
      )
      .join('\n\n');
  });
}

function cmdSnooze(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch snooze <ref> <when>'));
  const when = p.positional.slice(1).join(' ') || str(p, 'until');
  if (!when) throw new CliError('Snooze until when?  orch snooze demo-3 3d');

  const until = parseWhenOrThrow(when);
  const updated = updateTask(db, task.id, { snoozeUntil: until }, actor(p));
  emitTask(p, updated, `hidden until ${until.toISOString().slice(0, 16).replace('T', ' ')}`);
}

function cmdEdit(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch edit <ref> [options]'));
  const title = p.positional.slice(1).join(' ').trim();
  const due = str(p, 'due');
  const recur = str(p, 'recur');

  if (recur && recur !== 'none' && !isValidCron(recur)) {
    throw new CliError('--recur needs a 5-field cron expression, or "none" to stop repeating.');
  }

  const updated = updateTask(
    db,
    task.id,
    {
      title: title || str(p, 'title'),
      body: str(p, 'body'),
      priority: num(p, 'priority'),
      project: str(p, 'project'),
      assignee: present(p, 'assign') ? (str(p, 'assign') ?? null) : undefined,
      dueAt: due ? (due === 'none' ? null : parseWhenOrThrow(due)) : undefined,
      recur: recur ? (recur === 'none' ? null : recur) : undefined,
    },
    actor(p),
  );

  for (const tag of list(p, 'tag')) attachTag(db, task.id, tag);
  for (const tag of list(p, 'untag')) detachTag(db, task.id, tag);

  emitTask(p, requireTask(db, updated.ref), 'updated');
}

function cmdRm(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orch rm <ref>'));
  deleteTask(db, task.id, actor(p));
  out(p, { deleted: task.ref }, () => `${c.dim('deleted')} ${task.ref}`);
}

function cmdDep(db: Db, p: Parsed): void {
  const [action, taskRef, blockerRef] = p.positional;
  if (!action || !taskRef || !blockerRef) {
    throw new CliError('Usage: orch dep add|rm <ref> <blocker-ref>');
  }
  const task = requireTask(db, taskRef);
  const blocker = requireTask(db, blockerRef);
  const kind = (str(p, 'kind') ?? 'blocks') as 'blocks' | 'relates' | 'parent';

  if (action === 'add') addDep(db, task.id, blocker.id, kind);
  else if (action === 'rm') removeDep(db, task.id, blocker.id, kind);
  else throw new CliError(`Unknown action "${action}". Use add or rm.`);

  emitTask(p, requireTask(db, task.ref), `${action === 'add' ? 'now' : 'no longer'} ${kind} ${blocker.ref}`);
}

function cmdTag(db: Db, p: Parsed): void {
  const [action, taskRef, ...names] = p.positional;
  if (!action || !taskRef || !names.length) {
    throw new CliError('Usage: orch tag add|rm <ref> <tag>...');
  }
  const task = requireTask(db, taskRef);
  for (const name of names) {
    if (action === 'add') attachTag(db, task.id, name);
    else if (action === 'rm') detachTag(db, task.id, name);
    else throw new CliError(`Unknown action "${action}". Use add or rm.`);
  }
  emitTask(p, requireTask(db, task.ref), 'updated');
}

function cmdProject(db: Db, p: Parsed): void {
  const [action = 'ls', key] = p.positional;

  if (action === 'ls') {
    const projects = listProjects(db, bool(p, 'all'));
    out(p, projects, () =>
      projects.length
        ? projects
            .map((x) => {
              const open = listTasks(db, { project: x.key }).length;
              const suffix = x.archived_at ? c.dim(' (archived)') : '';
              return `${c.bold(x.key.padEnd(12))} ${x.name}${suffix}  ${c.dim(`${open} open`)}`;
            })
            .join('\n')
        : c.dim('No projects. Try: orch project add <key>'),
    );
    return;
  }

  if (!key) throw new CliError(`Usage: orch project ${action} <key>`);

  if (action === 'add') {
    const project = createProject(db, key, str(p, 'name'), str(p, 'color'));
    out(p, project, () => `${c.dim('created project')} ${c.bold(project.key)}`);
  } else if (action === 'archive' || action === 'unarchive') {
    const project = archiveProject(db, key, action === 'archive');
    out(p, project, () => `${c.bold(project.key)} ${action}d`);
  } else {
    throw new CliError(`Unknown action "${action}". Use ls, add, archive, or unarchive.`);
  }
}

function cmdDigest(db: Db, p: Parsed): void {
  const report = digest(db, str(p, 'project'));
  out(p, report, () => {
    const section = (label: string, tasks: TaskView[], color: (s: string) => string) =>
      tasks.length ? `${color(c.bold(label))}\n${taskTable(tasks)}` : '';

    const parts = [
      section(`Waiting on you (${report.needs_input.length})`, report.needs_input, c.magenta),
      section(`Overdue (${report.overdue.length})`, report.overdue, c.red),
      section(`Due today (${report.due_today.length})`, report.due_today, c.yellow),
      section(`Ready (${report.ready.length})`, report.ready, c.cyan),
      section(`In progress (${report.in_progress.length})`, report.in_progress, c.blue),
      section(`Abandoned leases (${report.stale_leases.length})`, report.stale_leases, c.magenta),
    ].filter(Boolean);

    return parts.length ? parts.join('\n\n') : c.dim('Nothing needs attention.');
  });
}

function cmdFeed(db: Db, p: Parsed): void {
  const events = recentEvents(db, num(p, 'limit') ?? 30);
  out(p, events, () =>
    events.length
      ? events
          .map((e) => `${c.dim(e.at.slice(5, 16).replace('T', ' '))}  ${c.bold(e.task_ref ?? '—')}  ${describeEvent(e)}`)
          .join('\n')
      : c.dim('No activity yet.'),
  );
}

async function cmdUi(db: Db, p: Parsed): Promise<void> {
  await ensureUiBuilt();
  const { startServer, isLoopback } = await import('../server/index.ts');

  // `--host` with no value means "all interfaces", which is what people expect
  // from every other dev server.
  const host = present(p, 'host')
    ? (str(p, 'host') ?? '0.0.0.0')
    : (process.env.ORCH_HOST ?? '127.0.0.1');

  let token: string | undefined;
  if (!isLoopback(host) && !bool(p, 'no-auth')) {
    // Off-loopback the board is readable and writable by anyone who can reach
    // the port, so it gets a shared secret unless you explicitly opt out.
    token = str(p, 'token') ?? process.env.ORCH_TOKEN ?? randomBytes(16).toString('base64url');
  }

  await startServer(db, {
    port: num(p, 'port') ?? 4477,
    open: !bool(p, 'no-open'),
    host,
    token,
  });
}

/**
 * Build the UI on first run rather than serving a page that explains how to
 * build it. "It told me to run a command" is a worse first experience than
 * waiting two seconds, and forgetting the build step otherwise produces a
 * screen that looks broken.
 */
async function ensureUiBuilt(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (existsSync(join(root, 'dist', 'index.html'))) return;

  console.log('Building the board (first run only)…');
  try {
    const { build } = await import('vite');
    // Pass configFile, not root. Given a bare `root`, Vite ignores
    // vite.config.ts and writes to <root>/dist, which is not where the server
    // looks.
    await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
  } catch (err) {
    throw new CliError(
      `Could not build the web UI automatically: ${(err as Error).message}\n` +
        `Run "npm install && npm run build" in ${root}, then try again.`,
    );
  }
}

function requirePositional(p: Parsed, index: number, usage: string): string {
  const value = p.positional[index];
  if (!value) throw new CliError(`Missing argument. Usage: ${usage}`);
  return value;
}

// ------------------------------------------------------------------ dispatch

export async function main(argv: string[]): Promise<number> {
  // A leading flag (`orch --help`, `orch --version`) is not a command.
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : '';
  const p = parseArgs(hasCommand ? argv.slice(1) : argv);

  if (!command || command === 'help' || bool(p, 'help')) {
    console.log(HELP);
    return 0;
  }
  if (command === 'instructions') {
    console.log(WORKFLOW);
    return 0;
  }
  if (command === 'where') {
    console.log(resolveDbPath());
    return 0;
  }

  const db = openDb();

  try {
    switch (command) {
      case 'init': cmdInit(db, p); return 0;
      case 'add': case 'new': cmdAdd(db, p); return 0;
      case 'ls': case 'list': cmdLs(db, p); return 0;
      case 'ready': cmdReady(db, p); return 0;
      case 'next': return cmdNext(db, p);
      case 'claim': return cmdClaim(db, p);
      case 'release': cmdRelease(db, p); return 0;
      case 'show': case 'view': cmdShow(db, p); return 0;
      case 'comment': cmdComment(db, p); return 0;
      case 'start': cmdStatus(db, p, 'in_progress'); return 0;
      case 'review': cmdStatus(db, p, 'review'); return 0;
      case 'done': case 'close': cmdStatus(db, p, 'done'); return 0;
      case 'cancel': cmdStatus(db, p, 'cancelled'); return 0;
      case 'reopen': cmdStatus(db, p, 'ready'); return 0;
      case 'ask': cmdAsk(db, p); return 0;
      case 'answer': case 'reply': cmdAnswer(db, p); return 0;
      case 'asking': case 'inbox': cmdAsking(db, p); return 0;
      case 'snooze': cmdSnooze(db, p); return 0;
      case 'edit': cmdEdit(db, p); return 0;
      case 'rm': case 'delete': cmdRm(db, p); return 0;
      case 'dep': cmdDep(db, p); return 0;
      case 'tag': cmdTag(db, p); return 0;
      case 'tags': {
        const tags = listTags(db);
        out(p, tags, () =>
          tags.length
            ? tags.map((t) => `${c.bold(`#${t.name}`.padEnd(16))} ${c.dim(`${t.count}`)}`).join('\n')
            : c.dim('No tags in use.'),
        );
        return 0;
      }
      case 'project': case 'projects': cmdProject(db, p); return 0;
      case 'digest': cmdDigest(db, p); return 0;
      case 'feed': case 'activity': cmdFeed(db, p); return 0;
      case 'ui': case 'serve': await cmdUi(db, p); return 0;
      default:
        console.error(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
  } finally {
    if (command !== 'ui' && command !== 'serve') db.close();
  }
}

export function run(): void {
  main(process.argv.slice(2))
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((err: Error) => {
      console.error(c.red('error') + ' ' + err.message);
      process.exitCode = 1;
    });
}

