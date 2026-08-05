import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolution order for the database file:
 *   1. $ORCH_DB
 *   2. `.orch/config.json` -> { "db": "..." }, searched from cwd upwards
 *   3. ~/.orch/orch.db
 *
 * The global default is deliberate: this is a hub that agents in many different
 * repos report into, so a per-repo default would fragment the queue.
 */
export function resolveDbPath(cwd = process.cwd()): string {
  if (process.env.ORCH_DB) return resolve(process.env.ORCH_DB);

  let dir = resolve(cwd);
  for (;;) {
    const cfg = join(dir, '.orch', 'config.json');
    if (existsSync(cfg)) {
      try {
        const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
        if (typeof parsed.db === 'string' && parsed.db.length > 0) {
          return resolve(dir, parsed.db);
        }
      } catch (err) {
        throw new Error(
          `Could not read ${cfg}: ${(err as Error).message}\n` +
            `Expected JSON shaped like {"db": "./orch.db"}.`,
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return join(homedir(), '.orch', 'orch.db');
}

const SCHEMA = `
CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  archived_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT NOT NULL UNIQUE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'backlog',
  priority         INTEGER NOT NULL DEFAULT 2,
  assignee         TEXT,
  lease_expires_at TEXT,
  due_at           TEXT,
  snooze_until     TEXT,
  recur            TEXT,
  recurs_from      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT,
  UNIQUE (project_id, seq)
);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE deps (
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (task_id, depends_on_id, kind),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  actor     TEXT NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  at        TEXT NOT NULL
);

CREATE INDEX idx_tasks_status     ON tasks(status);
CREATE INDEX idx_tasks_project    ON tasks(project_id);
CREATE INDEX idx_tasks_due        ON tasks(due_at);
CREATE INDEX idx_tasks_snooze     ON tasks(snooze_until);
CREATE INDEX idx_tasks_assignee   ON tasks(assignee);
CREATE INDEX idx_deps_depends_on  ON deps(depends_on_id);
CREATE INDEX idx_comments_task    ON comments(task_id);
CREATE INDEX idx_events_task      ON events(task_id);
CREATE INDEX idx_events_at        ON events(at);
`;

/** Ordered list of migrations. Index + 1 is the resulting `user_version`. */
const MIGRATIONS: string[] = [SCHEMA];

export type Db = DatabaseSync;

export function openDb(path?: string): Db {
  const file = path ?? resolveDbPath();
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // WAL lets the UI server read while a CLI process writes. busy_timeout covers
  // the brief windows where two writers overlap.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const txDepth = new WeakMap<Db, number>();

/**
 * Run `fn` inside an immediate write transaction. BEGIN IMMEDIATE (rather than
 * a deferred BEGIN) takes the write lock up front, so two concurrent writers
 * queue on busy_timeout instead of deadlocking on a lock upgrade mid-transaction.
 *
 * Reentrant: nested calls join the outer transaction via savepoints, so a
 * composite operation like "close a recurring task, then create its next
 * instance" stays atomic even though each half also transacts on its own.
 */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const nested = depth > 0;
  const savepoint = `orch_sp_${depth}`;

  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
