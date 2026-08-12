import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  defaultProject,
  deleteTask,
  detachTag,
  digest,
  endOfLocalDay,
  evaluateMemoryRetrieval,
  isValidCron,
  listComments,
  listEvents,
  listMemories,
  listProjects,
  listTags,
  listTasks,
  mergeAgentsFile,
  memoryContextForTask,
  memoryBacklinks,
  memoryDiff,
  memoryGraph,
  memoryHistory,
  memoryStatus,
  inspectMemoryMigration,
  lintMemories,
  linkMemory,
  migrateMemoryStore,
  openDb,
  parseDuration,
  parseWhenOrThrow,
  readyTasks,
  recentEvents,
  reindexMemories,
  releaseTask,
  removeDep,
  requireTask,
  requireProject,
  envSetting,
  resolveDbPath,
  resolveMemoryPath,
  rememberMemory,
  searchMemories,
  unlinkMemory,
  getMemory,
  updateMemory,
  archiveMemory,
  commitMemory,
  setStatus,
  skillFile,
  snoozeTask,
  updateTask,
  STATUSES,
  MEMORY_KINDS,
  MEMORY_RELATION_TYPES,
  MEMORY_STATUSES,
  MEMORY_TARGET_TYPES,
  type Db,
  type MemoryKind,
  type MemoryRelationType,
  type MemorySearchOptions,
  type MemoryStatus,
  type MemoryTargetType,
  type Project,
  type RetrievalGoldenCase,
  type Status,
  type TaskView,
} from '../core/index.ts';

import { bool, list, num, parseArgs, present, str, type Parsed } from './args.ts';
import {
  c,
  describeEvent,
  json,
  memoryContextText,
  memoryBacklinkTable,
  memoryDetail,
  memoryEvaluationText,
  memoryGraphText,
  memoryLintText,
  memoryMigrationText,
  memorySuggestions,
  memorySearchTable,
  memoryTable,
  taskDetail,
  taskTable,
} from './format.ts';

const HELP = `orchestration — a local to-do queue that agents can read, claim, and report to.

Usage: orchestration <command> [options]

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
  ls [text]                 List open tasks; search refs, titles, bodies, tags, comments
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

Memory (stored outside the repo in ~/.orchestration/memory)
  remember "<learning>"     Save a durable project memory
  memory ls|search|show     Find and inspect memories
  memory search <query> [--kind K] [--status S] [--tag T] [--source S]
                     [--verified] [--semantic] [--graph-depth 0-3] [--explain]
  memory edit <id> [--title|--body|--kind|--status|--tag|--verified]
  memory promote|archive <id>
  memory link|unlink <id> <target> [--relation relates] [--target-type memory]
  memory backlinks <target> [--target-type memory]
  memory graph [id] [--depth 2] [--limit 200]
  memory lint             Audit aliases, links, targets, and supersession
  memory suggest-links <id> [--limit 5]
  memory evaluate <golden.json> [--k N]
  memory migrate [--dry-run] [--from PATH] [--to PATH]
  memory diff|history|status|commit
  memory reindex            Rebuild the SQLite index from Markdown
  context <task-ref>        Show bounded memory relevant to a task

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
    envSetting('ACTOR') ??
    envSetting('AGENT') ??
    userInfo().username
  );
}

/**
 * Who to credit for an action on a task already in hand. Falls back to the
 * current assignee before the OS user, so an agent that claimed as `bruno` and
 * then ran `orchestration ask` without repeating `--agent` is still recorded as bruno
 * rather than as whoever owns the shell.
 */
function actorFor(p: Parsed, task: TaskView): string {
  return (
    str(p, 'agent') ??
    str(p, 'as') ??
    envSetting('ACTOR') ??
    envSetting('AGENT') ??
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

  const skillPath = join(root, '.claude', 'skills', 'orchestration', 'SKILL.md');
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
      `Add your first task:  ${c.bold(`orchestration add "Something to do" -p ${project.key}`)}`,
      `Open the board:       ${c.bold('orchestration ui')}`,
    ].join('\n'),
  );
}

function cmdAdd(db: Db, p: Parsed): void {
  const title = p.positional.join(' ').trim();
  if (!title) throw new CliError('What should the task be called?  orchestration add "Fix the parser"');

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

  const memory = memoryContextForTask(db, resolveMemoryPath(), task);
  if (bool(p, 'json')) console.log(json({ ...task, memory }));
  else console.log(taskDetail(task, listComments(db, task.id), [], memory));
  return 0;
}

function cmdClaim(db: Db, p: Parsed): number {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration claim <ref>'));
  const claimed = claimTask(db, task.id, actor(p), leaseMs(p));

  if (!claimed) {
    const current = requireTask(db, task.ref);
    throw new CliError(
      current.blocked_by.length
        ? `${task.ref} is blocked by ${current.blocked_by.join(', ')}.`
        : current.assignee
          ? `${task.ref} is already held by ${current.assignee}. Try "orchestration next --claim".`
          : `${task.ref} is not claimable (status: ${current.status}).`,
    );
  }
  emitTask(p, claimed, `claimed by ${claimed.assignee}`);
  return 0;
}

function cmdRelease(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration release <ref>'));
  emitTask(p, releaseTask(db, task.id, actor(p)), 'released');
}

function cmdShow(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration show <ref>'));
  const comments = listComments(db, task.id);
  const events = listEvents(db, task.id);
  const memory = memoryContextForTask(db, resolveMemoryPath(), task);
  out(p, { ...task, comments, events, memory }, () => taskDetail(task, comments, events, memory));
}

function cmdComment(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration comment <ref> "<text>"'));
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
  const task = requireTask(db, requirePositional(p, 0, `orchestration ${status} <ref>`));
  const note = str(p, 'message') ?? p.positional.slice(1).join(' ');
  const who = actorFor(p, task);
  if (note.trim()) addComment(db, task.id, who, note, 'progress');

  const { task: updated, recurrence } = setStatus(db, task.id, status, who);
  out(p, { task: updated, recurrence }, () => {
    const lines = [`${c.bold(updated.ref)} → ${updated.status}`];
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
  const task = requireTask(db, requirePositional(p, 0, 'orchestration ask <ref> "<question>"'));
  const question = str(p, 'message') ?? p.positional.slice(1).join(' ');
  if (!question.trim()) {
    throw new CliError('What do you need to know?  orchestration ask demo-3 "Which auth flow?"');
  }

  const { task: updated } = askForInput(db, task.id, actorFor(p, task), question);
  out(p, updated, () =>
    [
      `${c.bold(updated.ref)} → ${c.magenta(updated.status)}`,
      // Both lines describe the row as it was read back after the write, so a
      // write that did not land cannot print a success message anyway.
      updated.status === 'needs_input'
        ? c.dim('Waiting on a human. It has left the queue and the lease is released.')
        : c.dim('The question was recorded, but the task did not move to needs_input.'),
    ].join('\n'),
  );
}

function cmdAnswer(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration answer <ref> "<answer>"'));
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
          c.dim(`  answer with: orchestration answer ${t.ref} "..."`),
        ].join('\n'),
      )
      .join('\n\n');
  });
}

function cmdSnooze(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration snooze <ref> <when>'));
  const when = p.positional.slice(1).join(' ') || str(p, 'until');
  if (!when) throw new CliError('Snooze until when?  orchestration snooze demo-3 3d');

  const until = parseWhenOrThrow(when);
  const updated = snoozeTask(db, task.id, until, actor(p));
  emitTask(p, updated, `hidden until ${until.toISOString().slice(0, 16).replace('T', ' ')}`);
}

function cmdEdit(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration edit <ref> [options]'));
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
  const task = requireTask(db, requirePositional(p, 0, 'orchestration rm <ref>'));
  deleteTask(db, task.id, actor(p));
  out(p, { deleted: task.ref }, () => `${c.dim('deleted')} ${task.ref}`);
}

function cmdDep(db: Db, p: Parsed): void {
  const [action, taskRef, blockerRef] = p.positional;
  if (!action || !taskRef || !blockerRef) {
    throw new CliError('Usage: orchestration dep add|rm <ref> <blocker-ref>');
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
    throw new CliError('Usage: orchestration tag add|rm <ref> <tag>...');
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
        : c.dim('No projects. Try: orchestration project add <key>'),
    );
    return;
  }

  if (!key) throw new CliError(`Usage: orchestration project ${action} <key>`);

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

function selectedMemoryProject(db: Db, p: Parsed): Project | null {
  if (bool(p, 'global')) return null;
  const key = str(p, 'project');
  return key ? requireProject(db, key) : defaultProject(db);
}

function parsedMemoryKind(p: Parsed): MemoryKind | undefined {
  const raw = str(p, 'kind');
  if (!raw) return undefined;
  if (!MEMORY_KINDS.includes(raw as MemoryKind)) {
    throw new CliError(`Unknown memory kind "${raw}". Valid: ${MEMORY_KINDS.join(', ')}.`);
  }
  return raw as MemoryKind;
}

function parsedMemoryStatus(p: Parsed): MemoryStatus | undefined {
  const raw = bool(p, 'candidate') ? 'candidate' : str(p, 'status');
  if (!raw) return undefined;
  if (!MEMORY_STATUSES.includes(raw as MemoryStatus)) {
    throw new CliError(`Unknown memory status "${raw}". Valid: ${MEMORY_STATUSES.join(', ')}.`);
  }
  return raw as MemoryStatus;
}

function parsedMemoryKinds(p: Parsed): MemoryKind[] | undefined {
  const kinds = list(p, 'kind');
  for (const kind of kinds) {
    if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
      throw new CliError(`Unknown memory kind "${kind}". Valid: ${MEMORY_KINDS.join(', ')}.`);
    }
  }
  return kinds.length ? kinds as MemoryKind[] : undefined;
}

function parsedMemoryStatuses(p: Parsed): MemoryStatus[] | undefined {
  const statuses = list(p, 'status');
  for (const status of statuses) {
    if (!MEMORY_STATUSES.includes(status as MemoryStatus)) {
      throw new CliError(`Unknown memory status "${status}". Valid: ${MEMORY_STATUSES.join(', ')}.`);
    }
  }
  return statuses.length ? statuses as MemoryStatus[] : undefined;
}

function parsedGraphDepth(p: Parsed): number | undefined {
  const depth = num(p, 'graph-depth');
  if (depth === undefined) return undefined;
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) {
    throw new CliError(`--graph-depth needs an integer from 0 to 3. Got "${depth}".`);
  }
  return depth;
}

function memorySearchOptions(p: Parsed): MemorySearchOptions {
  return {
    all: bool(p, 'all'),
    limit: num(p, 'limit'),
    kind: parsedMemoryKinds(p),
    status: parsedMemoryStatuses(p),
    tag: list(p, 'tag').length ? list(p, 'tag') : undefined,
    source: list(p, 'source').length ? list(p, 'source') : undefined,
    verified: bool(p, 'verified') ? true : undefined,
    semantic: bool(p, 'semantic'),
    graphDepth: parsedGraphDepth(p),
  };
}

async function runMemorySearch(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options: MemorySearchOptions,
) {
  return options.semantic
    ? await searchMemories(db, root, project, query, { ...options, semantic: true })
    : searchMemories(db, root, project, query, { ...options, semantic: false });
}

function parsedMemoryRelation(p: Parsed): MemoryRelationType {
  const raw = str(p, 'relation');
  if (present(p, 'relation') && !raw) {
    throw new CliError(`--relation needs one of: ${MEMORY_RELATION_TYPES.join(', ')}.`);
  }
  const relation = raw ?? 'relates';
  if (!MEMORY_RELATION_TYPES.includes(relation as MemoryRelationType)) {
    throw new CliError(`Unknown memory relation "${relation}". Valid: ${MEMORY_RELATION_TYPES.join(', ')}.`);
  }
  return relation as MemoryRelationType;
}

function parsedMemoryTargetType(p: Parsed): MemoryTargetType {
  const raw = str(p, 'target-type');
  if (present(p, 'target-type') && !raw) {
    throw new CliError(`--target-type needs one of: ${MEMORY_TARGET_TYPES.join(', ')}.`);
  }
  const targetType = raw ?? 'memory';
  if (!MEMORY_TARGET_TYPES.includes(targetType as MemoryTargetType)) {
    throw new CliError(`Unknown memory target type "${targetType}". Valid: ${MEMORY_TARGET_TYPES.join(', ')}.`);
  }
  return targetType as MemoryTargetType;
}

function retrievalGolden(path: string): { cases: RetrievalGoldenCase[]; k?: number } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new CliError(`Could not read retrieval golden file ${path}: ${(err as Error).message}`);
  }
  const envelope = Array.isArray(decoded)
    ? { cases: decoded, k: undefined }
    : decoded !== null && typeof decoded === 'object'
      ? decoded as { cases?: unknown; k?: unknown }
      : null;
  if (!envelope || !Array.isArray(envelope.cases)) {
    throw new CliError('Retrieval golden JSON must be an array of cases or an object shaped as {"cases":[...],"k":3}.');
  }
  if (!envelope.cases.length) throw new CliError('Retrieval golden JSON needs at least one case.');
  const cases = envelope.cases.map((candidate, index): RetrievalGoldenCase => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new CliError(`Retrieval golden case ${index + 1} must be an object.`);
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.query !== 'string' || !value.query.trim()) {
      throw new CliError(`Retrieval golden case ${index + 1} needs a non-empty "query".`);
    }
    if (!Array.isArray(value.relevant) || !value.relevant.length ||
        !value.relevant.every((item) => typeof item === 'string' && item.trim())) {
      throw new CliError(`Retrieval golden case ${index + 1} needs a non-empty string array in "relevant".`);
    }
    if (value.options !== undefined &&
        (value.options === null || typeof value.options !== 'object' || Array.isArray(value.options))) {
      throw new CliError(`Retrieval golden case ${index + 1} "options" must be an object.`);
    }
    return {
      name: typeof value.name === 'string' ? value.name : undefined,
      query: value.query.trim(),
      relevant: (value.relevant as string[]).map((item) => item.trim()),
      options: value.options as RetrievalGoldenCase['options'],
    };
  });
  const k = envelope.k;
  if (k !== undefined && (typeof k !== 'number' || !Number.isInteger(k) || k < 1)) {
    throw new CliError('Retrieval golden file "k" must be a positive integer.');
  }
  return { cases, k: k === undefined ? undefined : Number(k) };
}

function cmdRemember(db: Db, p: Parsed, positionalStart = 0): void {
  const body = str(p, 'body') ?? str(p, 'message') ?? p.positional.slice(positionalStart).join(' ');
  if (!body.trim()) {
    throw new CliError('What should be remembered?  orchestration remember "The UI tests need a build first"');
  }
  const project = selectedMemoryProject(db, p);
  const review = str(p, 'review-after');
  const memory = rememberMemory(db, resolveMemoryPath(), {
    body,
    title: str(p, 'title'),
    kind: parsedMemoryKind(p),
    status: parsedMemoryStatus(p),
    tags: list(p, 'tag'),
    sources: list(p, 'source'),
    author: actor(p),
    lastVerifiedAt: bool(p, 'verified') ? new Date().toISOString() : null,
    reviewAfter: review ? parseWhenOrThrow(review).toISOString() : null,
    supersedes: str(p, 'supersedes'),
    project,
  });
  out(p, memory, () => `${c.dim('remembered')} ${c.bold(memory.id.slice(0, 12))}  ${memory.title}\n${c.dim(memory.path)}`);
}

async function cmdMemory(db: Db, p: Parsed): Promise<void> {
  const [action = 'ls', identifier] = p.positional;
  const root = resolveMemoryPath();

  if (action === 'where') {
    out(p, { root }, () => root);
    return;
  }
  if (action === 'status') {
    const status = memoryStatus(root);
    out(p, { root, status }, () => status);
    return;
  }
  if (action === 'migrate' || action === 'migration') {
    const options = {
      source: str(p, 'from'),
      destination: str(p, 'to'),
      allowUnresolvedMemoryTargets: bool(p, 'allow-unresolved'),
    };
    const dryRun = bool(p, 'dry-run');
    const result = dryRun
      ? inspectMemoryMigration(db, options)
      : migrateMemoryStore(db, options);
    const payload = { dry_run: dryRun, ...result };
    out(p, payload, () => memoryMigrationText(payload));
    return;
  }
  if (action === 'diff' && !identifier) {
    const diff = memoryDiff(root);
    out(p, { root, diff }, () => diff);
    return;
  }
  if ((action === 'history' || action === 'log') && !identifier) {
    const history = memoryHistory(root);
    out(p, { root, history }, () => history);
    return;
  }
  if (action === 'commit') {
    const project = selectedMemoryProject(db, p);
    reindexMemories(db, root, project);
    const committed = commitMemory(root, str(p, 'message'));
    out(p, { root, committed }, () => committed ? 'Memory changes committed.' : 'Could not initialize or commit memory history.');
    return;
  }

  const project = selectedMemoryProject(db, p);
  if (action === 'add' || action === 'remember') {
    cmdRemember(db, p, 1);
    return;
  }
  if (action === 'ls' || action === 'list') {
    const memories = listMemories(db, root, project, { all: bool(p, 'all'), limit: num(p, 'limit') });
    out(p, memories, () => memoryTable(memories));
    return;
  }
  if (action === 'search' || action === 'find') {
    const query = str(p, 'search') ?? p.positional.slice(1).join(' ');
    const memories = await runMemorySearch(db, root, project, query, memorySearchOptions(p));
    out(p, memories, () => memorySearchTable(memories, bool(p, 'explain')));
    return;
  }
  if (action === 'reindex' || action === 'sync') {
    const memories = reindexMemories(db, root, project);
    out(p, { root, indexed: memories.length }, () => `Indexed ${memories.length} memories from ${root}`);
    return;
  }
  if (action === 'lint') {
    const issues = lintMemories(db, root, project);
    out(p, issues, () => memoryLintText(issues));
    return;
  }
  if (action === 'graph') {
    const graph = memoryGraph(db, root, project, identifier, {
      depth: num(p, 'depth'),
      limit: num(p, 'limit'),
    });
    out(p, graph, () => memoryGraphText(graph));
    return;
  }
  if (action === 'backlinks') {
    if (!identifier) throw new CliError('Usage: orchestration memory backlinks <target> [--target-type memory]');
    const targetType = parsedMemoryTargetType(p);
    const backlinks = memoryBacklinks(db, root, project, targetType, identifier);
    out(p, { target_type: targetType, target: identifier, backlinks }, () => memoryBacklinkTable(backlinks));
    return;
  }
  if (action === 'evaluate' || action === 'eval') {
    if (!identifier) throw new CliError('Usage: orchestration memory evaluate <golden.json> [--k N]');
    const golden = retrievalGolden(identifier);
    const overrideK = num(p, 'k');
    if (present(p, 'k') && overrideK === undefined) throw new CliError('--k needs a positive integer.');
    const requestedK = overrideK ?? golden.k;
    if (requestedK !== undefined && (!Number.isInteger(requestedK) || requestedK < 1)) {
      throw new CliError(`--k needs a positive integer. Got "${requestedK}".`);
    }
    const evaluation = await evaluateMemoryRetrieval(db, root, project, golden.cases, { k: requestedK });
    out(p, evaluation, () => memoryEvaluationText(evaluation));
    return;
  }
  if (!identifier) throw new CliError(`Usage: orchestration memory ${action} <id>`);
  const memory = getMemory(db, root, project, identifier);

  if (action === 'link' || action === 'unlink') {
    const target = p.positional[2];
    if (!target) {
      throw new CliError(`Usage: orchestration memory ${action} <id> <target> [--relation relates] [--target-type memory]`);
    }
    const relation = {
      type: parsedMemoryRelation(p),
      target_type: parsedMemoryTargetType(p),
      target,
    };
    const updated = action === 'link'
      ? linkMemory(db, root, project, memory.id, relation)
      : unlinkMemory(db, root, project, memory.id, relation);
    out(p, updated, () => memoryDetail(updated));
    return;
  }
  if (action === 'suggest-links' || action === 'suggest') {
    const existingTargets = new Set(memory.relations
      .filter((relation) => relation.target_type === 'memory')
      .map((relation) => relation.target));
    const wanted = Math.max(1, num(p, 'limit') ?? 5);
    const query = [memory.title, ...memory.aliases, ...memory.tags].join(' ');
    const suggestions = (await runMemorySearch(db, root, project, query, {
      ...memorySearchOptions(p),
      limit: Math.max(wanted * 3, 10),
    })).filter((candidate) => candidate.id !== memory.id && !existingTargets.has(candidate.id)).slice(0, wanted);
    out(p, { source_id: memory.id, suggestions }, () => memorySuggestions(memory, suggestions, bool(p, 'explain')));
    return;
  }

  if (action === 'show' || action === 'view') {
    out(p, memory, () => memoryDetail(memory));
    return;
  }
  if (action === 'diff') {
    const diff = memoryDiff(root, memory.path);
    out(p, { id: memory.id, diff }, () => diff);
    return;
  }
  if (action === 'history' || action === 'log') {
    const history = memoryHistory(root, memory.path);
    out(p, { id: memory.id, history }, () => history);
    return;
  }
  if (action === 'promote') {
    const updated = updateMemory(db, root, project, memory.id, { status: 'active' });
    out(p, updated, () => `${c.bold(updated.id.slice(0, 12))} → ${updated.status}`);
    return;
  }
  if (action === 'archive' || action === 'forget') {
    const updated = archiveMemory(db, root, project, memory.id);
    out(p, updated, () => `${c.bold(updated.id.slice(0, 12))} → ${updated.status}`);
    return;
  }
  if (action === 'edit') {
    const hasChanges = ['title', 'body', 'kind', 'status', 'tag', 'source', 'author', 'review-after', 'supersedes']
      .some((name) => present(p, name)) || bool(p, 'verified') || bool(p, 'candidate');
    if (!hasChanges) {
      out(p, memory, () => `${memory.path}\n${c.dim('Edit this Markdown file directly, then run: orchestration memory commit')}`);
      return;
    }
    const review = str(p, 'review-after');
    const updated = updateMemory(db, root, project, memory.id, {
      title: str(p, 'title'),
      body: str(p, 'body'),
      kind: parsedMemoryKind(p),
      status: parsedMemoryStatus(p),
      tags: present(p, 'tag') ? list(p, 'tag') : undefined,
      sources: present(p, 'source') ? list(p, 'source') : undefined,
      author: present(p, 'author') ? (str(p, 'author') ?? null) : undefined,
      lastVerifiedAt: bool(p, 'verified') ? new Date().toISOString() : undefined,
      reviewAfter: review ? parseWhenOrThrow(review).toISOString() : undefined,
      supersedes: str(p, 'supersedes'),
    });
    out(p, updated, () => `${c.dim('updated')} ${c.bold(updated.id.slice(0, 12))}  ${updated.title}`);
    return;
  }

  throw new CliError(`Unknown memory action "${action}". Use ls, search, show, edit, promote, archive, link, unlink, backlinks, graph, lint, suggest-links, evaluate, migrate, diff, history, status, commit, or reindex.`);
}

function cmdContext(db: Db, p: Parsed): void {
  const task = requireTask(db, requirePositional(p, 0, 'orchestration context <task-ref>'));
  const memory = memoryContextForTask(db, resolveMemoryPath(), task, num(p, 'limit') ?? 3);
  out(p, { task_ref: task.ref, memory }, () =>
    memory.pinned.length || memory.matches.length
      ? memoryContextText(memory)
      : c.dim(`No relevant memory for ${task.ref}.`),
  );
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
    : (envSetting('HOST') ?? '127.0.0.1');

  let token: string | undefined;
  if (!isLoopback(host) && !bool(p, 'no-auth')) {
    // Off-loopback the board is readable and writable by anyone who can reach
    // the port, so it gets a shared secret unless you explicitly opt out.
    token = str(p, 'token') ?? envSetting('TOKEN') ?? randomBytes(16).toString('base64url');
  }

  await startServer(db, {
    port: num(p, 'port') ?? 4477,
    open: !bool(p, 'no-open'),
    host,
    token,
  });
}

const UI_BUILD_STAMP = '.orchestration-ui-build.json';

function uiSourceFiles(root: string): string[] {
  const files = ['vite.config.ts', 'package.json', 'package-lock.json']
    .map((name) => join(root, name))
    .filter(existsSync);
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(join(root, 'web'));
  return files.sort();
}

/** Content identity for the source files that produce the board bundle. */
export function uiBuildFingerprint(root: string): string {
  const digest = createHash('sha256');
  for (const path of uiSourceFiles(root)) {
    digest.update(path.slice(root.length));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}

/** Existing bundles are reusable only when they were built from these sources. */
export function uiBuildIsFresh(root: string): boolean {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) return false;
  // Published packages ship the prebuilt bundle but intentionally omit the
  // frontend source. Their bundle is immutable for that installed version.
  if (!existsSync(join(root, 'web'))) return true;
  try {
    const stamp = JSON.parse(readFileSync(join(dist, UI_BUILD_STAMP), 'utf8')) as {
      fingerprint?: unknown;
    };
    return stamp.fingerprint === uiBuildFingerprint(root);
  } catch {
    return false;
  }
}

/**
 * Build the UI automatically and refresh it whenever its source identity
 * changes. A first-run-only check can serve an old bundle forever after a pull.
 */
async function ensureUiBuilt(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (uiBuildIsFresh(root)) return;

  console.log(existsSync(join(root, 'dist', 'index.html'))
    ? 'Refreshing the board after source changes…'
    : 'Building the board…');
  try {
    const { build } = await import('vite');
    // Pass configFile, not root. Given a bare `root`, Vite ignores
    // vite.config.ts and writes to <root>/dist, which is not where the server
    // looks.
    await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
    writeFileSync(
      join(root, 'dist', UI_BUILD_STAMP),
      `${JSON.stringify({ version: 1, fingerprint: uiBuildFingerprint(root) }, null, 2)}\n`,
    );
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
  // A leading flag (`orchestration --help`, `orchestration --version`) is not a command.
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
      case 'remember': cmdRemember(db, p); return 0;
      case 'memory': case 'memories': await cmdMemory(db, p); return 0;
      case 'context': cmdContext(db, p); return 0;
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
