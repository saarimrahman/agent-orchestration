import { userInfo } from 'node:os';

import {
  addComment as coreAddComment,
  addDep,
  answerInput,
  archiveProject as coreArchiveProject,
  askForInput,
  attachTag,
  awaitingInput,
  claimNext as coreClaimNext,
  claimTask,
  createProject as coreCreateProject,
  createTask as coreCreateTask,
  detachTag,
  digest as coreDigest,
  envSetting,
  findTask,
  listComments,
  listEvents,
  listProjects,
  listTasks as coreListTasks,
  openDb,
  parseWhenOrThrow,
  readyTasks,
  releaseTask,
  removeDep,
  requireTask as coreRequireTask,
  resolveDbPath,
  setStatus,
  snoozeTask as coreSnoozeTask,
  updateTask as coreUpdateTask,
  type Comment,
  type CommentKind,
  type CreateInput,
  type Db,
  type DepKind,
  type Digest,
  type EventView,
  type ListFilter,
  type Project,
  type QueueOptions,
  type Status,
  type TaskView,
  type UpdateInput,
} from './core/index.ts';

export type {
  Comment,
  CommentKind,
  DepKind,
  Digest,
  EventView,
  Project,
  Status,
  TaskView,
} from './core/index.ts';

/** A timestamp accepted by the SDK. Strings use the same parser as the CLI. */
export type When = Date | string;

export type OrchestrationOptions = {
  /** Defaults to normal database resolution: env, workspace config, then the user store. */
  databasePath?: string;
  /** Resolve workspace configuration from here without changing the process working directory. */
  cwd?: string;
  /** Credited on comments and mutations. Defaults the same way as the CLI. */
  actor?: string;
};

export type CreateTaskOptions = Omit<CreateInput, 'actor' | 'dueAt' | 'snoozeUntil'> & {
  dueAt?: When | null;
  snoozeUntil?: When | null;
};

export type UpdateTaskOptions = Omit<UpdateInput, 'dueAt' | 'snoozeUntil'> & {
  dueAt?: When | null;
};

export type ListTaskOptions = Omit<ListFilter, 'dueBefore'> & {
  dueBefore?: When;
};

export type ClaimNextOptions = QueueOptions & { leaseMs?: number };

export type StatusResult = { task: TaskView; recurrence: TaskView | null };
export type CommentResult = { task: TaskView; comment: Comment };

/**
 * The supported programmatic surface for scripts and agents.
 *
 * Methods accept stable task refs and delegate all queue rules and persistence
 * to the same core used by the CLI. Call `close()` when the script is finished,
 * or use `using` in runtimes that support explicit resource management.
 */
export interface OrchestrationClient extends Disposable {
  readonly actor: string;

  close(): void;

  createProject(key: string, name?: string, color?: string): Project;
  archiveProject(key: string, archived?: boolean): Project;
  projects(includeArchived?: boolean): Project[];

  createTask(input: CreateTaskOptions): TaskView;
  getTask(ref: string): TaskView | null;
  requireTask(ref: string): TaskView;
  listTasks(options?: ListTaskOptions): TaskView[];
  ready(options?: QueueOptions): TaskView[];
  inbox(project?: string): TaskView[];
  digest(project?: string): Digest;

  claimTask(ref: string, leaseMs?: number): TaskView | null;
  claimNext(options?: ClaimNextOptions): TaskView | null;
  releaseTask(ref: string): TaskView;
  updateTask(ref: string, input: UpdateTaskOptions): TaskView;
  snoozeTask(ref: string, until: When): TaskView;
  setTaskStatus(ref: string, status: Status): StatusResult;

  addComment(ref: string, body: string, kind?: CommentKind): Comment;
  askForInput(ref: string, question: string): CommentResult;
  answerInput(ref: string, answer: string): CommentResult;
  comments(ref: string): Comment[];
  events(ref: string): EventView[];

  addTag(ref: string, tag: string): TaskView;
  removeTag(ref: string, tag: string): TaskView;
  addDependency(ref: string, dependsOn: string, kind?: DepKind): TaskView;
  removeDependency(ref: string, dependsOn: string, kind?: DepKind): TaskView;
}

function asDate(value: When | null | undefined): Date | null | undefined {
  return typeof value === 'string' ? parseWhenOrThrow(value) : value;
}

function dueBefore(value: When | undefined): string | undefined {
  return value === undefined ? undefined : asDate(value)!.toISOString();
}

function defaultActor(explicit: string | undefined): string {
  return explicit?.trim() || envSetting('ACTOR') || envSetting('AGENT') || userInfo().username;
}

class Client implements OrchestrationClient {
  readonly actor: string;
  #database: Db | null;

  constructor(database: Db, actor: string) {
    this.#database = database;
    this.actor = actor;
  }

  #db(): Db {
    if (!this.#database) throw new Error('This orchestration client is closed.');
    return this.#database;
  }

  close(): void {
    if (!this.#database) return;
    this.#database.close();
    this.#database = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  createProject(key: string, name?: string, color?: string): Project {
    return coreCreateProject(this.#db(), key, name, color);
  }

  archiveProject(key: string, archived = true): Project {
    return coreArchiveProject(this.#db(), key, archived);
  }

  projects(includeArchived = false): Project[] {
    return listProjects(this.#db(), includeArchived);
  }

  createTask(input: CreateTaskOptions): TaskView {
    const { dueAt, snoozeUntil, ...rest } = input;
    return coreCreateTask(this.#db(), {
      ...rest,
      dueAt: asDate(dueAt),
      snoozeUntil: asDate(snoozeUntil),
      actor: this.actor,
    });
  }

  getTask(ref: string): TaskView | null {
    return findTask(this.#db(), ref);
  }

  requireTask(ref: string): TaskView {
    return coreRequireTask(this.#db(), ref);
  }

  listTasks(options: ListTaskOptions = {}): TaskView[] {
    const { dueBefore: before, ...rest } = options;
    return coreListTasks(this.#db(), { ...rest, dueBefore: dueBefore(before) });
  }

  ready(options: QueueOptions = {}): TaskView[] {
    return readyTasks(this.#db(), options);
  }

  inbox(project?: string): TaskView[] {
    return awaitingInput(this.#db(), project);
  }

  digest(project?: string): Digest {
    return coreDigest(this.#db(), project);
  }

  claimTask(ref: string, leaseMs?: number): TaskView | null {
    const task = coreRequireTask(this.#db(), ref);
    return claimTask(this.#db(), task.id, this.actor, leaseMs);
  }

  claimNext(options: ClaimNextOptions = {}): TaskView | null {
    return coreClaimNext(this.#db(), this.actor, options);
  }

  releaseTask(ref: string): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    return releaseTask(this.#db(), task.id, this.actor);
  }

  updateTask(ref: string, input: UpdateTaskOptions): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    if ('snoozeUntil' in input) {
      throw new Error('Use snoozeTask() to defer work without leaving it assigned.');
    }
    const { dueAt, ...rest } = input;
    return coreUpdateTask(
      this.#db(),
      task.id,
      { ...rest, dueAt: asDate(dueAt) },
      this.actor,
    );
  }

  snoozeTask(ref: string, until: When): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    return coreSnoozeTask(this.#db(), task.id, asDate(until)!, this.actor);
  }

  setTaskStatus(ref: string, status: Status): StatusResult {
    const task = coreRequireTask(this.#db(), ref);
    return setStatus(this.#db(), task.id, status, this.actor);
  }

  addComment(ref: string, body: string, kind: CommentKind = 'note'): Comment {
    const task = coreRequireTask(this.#db(), ref);
    return coreAddComment(this.#db(), task.id, this.actor, body, kind);
  }

  askForInput(ref: string, question: string): CommentResult {
    const task = coreRequireTask(this.#db(), ref);
    return askForInput(this.#db(), task.id, this.actor, question);
  }

  answerInput(ref: string, answer: string): CommentResult {
    const task = coreRequireTask(this.#db(), ref);
    return answerInput(this.#db(), task.id, this.actor, answer);
  }

  comments(ref: string): Comment[] {
    return listComments(this.#db(), coreRequireTask(this.#db(), ref).id);
  }

  events(ref: string): EventView[] {
    return listEvents(this.#db(), coreRequireTask(this.#db(), ref).id);
  }

  addTag(ref: string, tag: string): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    attachTag(this.#db(), task.id, tag);
    return coreRequireTask(this.#db(), task.ref);
  }

  removeTag(ref: string, tag: string): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    detachTag(this.#db(), task.id, tag);
    return coreRequireTask(this.#db(), task.ref);
  }

  addDependency(ref: string, dependsOn: string, kind: DepKind = 'blocks'): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    const dependency = coreRequireTask(this.#db(), dependsOn);
    addDep(this.#db(), task.id, dependency.id, kind);
    return coreRequireTask(this.#db(), task.ref);
  }

  removeDependency(ref: string, dependsOn: string, kind: DepKind = 'blocks'): TaskView {
    const task = coreRequireTask(this.#db(), ref);
    const dependency = coreRequireTask(this.#db(), dependsOn);
    removeDep(this.#db(), task.id, dependency.id, kind);
    return coreRequireTask(this.#db(), task.ref);
  }
}

/** Open a high-level orchestration client. The client owns the database connection. */
export function openOrchestration(options: OrchestrationOptions = {}): OrchestrationClient {
  const databasePath = options.databasePath ?? (options.cwd ? resolveDbPath(options.cwd) : undefined);
  return new Client(openDb(databasePath), defaultActor(options.actor));
}
