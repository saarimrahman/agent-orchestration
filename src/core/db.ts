import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CONFIG_DIRS, envSetting } from './env.ts';

/**
 * Resolution order for the database file:
 *   1. $ORCHESTRATION_DB, then $ORCH_DB
 *   2. `.orchestration/config.json` -> { "db": "..." }, searched from cwd
 *      upwards, then `.orch/config.json` at the same level
 *   3. ~/.orchestration/orchestration.db
 *   4. ~/.orch/orch.db, when it already exists
 *
 * The global default is deliberate: this is a hub that agents in many different
 * repos report into, so a per-repo default would fragment the queue. The older
 * `.orch` spellings are still read so a board created before the rename keeps
 * resolving without anyone moving files.
 */
export function resolveDbPath(cwd = process.cwd()): string {
  const configured = envSetting('DB');
  if (configured) return resolve(configured);

  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_DIRS) {
      const cfg = join(dir, name, 'config.json');
      if (!existsSync(cfg)) continue;
      try {
        const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
        if (typeof parsed.db === 'string' && parsed.db.length > 0) {
          return resolve(dir, parsed.db);
        }
      } catch (err) {
        throw new Error(
          `Could not read ${cfg}: ${(err as Error).message}\n` +
            `Expected JSON shaped like {"db": "./orchestration.db"}.`,
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const legacy = join(homedir(), '.orch', 'orch.db');
  const current = join(homedir(), '.orchestration', 'orchestration.db');
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
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

const MEMORY_SCHEMA = `
CREATE TABLE memory_documents (
  id               TEXT PRIMARY KEY,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  scope            TEXT NOT NULL,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL,
  title            TEXT NOT NULL,
  path             TEXT NOT NULL UNIQUE,
  tags             TEXT NOT NULL DEFAULT '[]',
  sources          TEXT NOT NULL DEFAULT '[]',
  author           TEXT,
  body             TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_verified_at TEXT,
  review_after     TEXT,
  supersedes       TEXT,
  content_hash     TEXT NOT NULL
);

CREATE INDEX idx_memory_project ON memory_documents(project_id);
CREATE INDEX idx_memory_scope   ON memory_documents(scope);
CREATE INDEX idx_memory_status  ON memory_documents(status);
CREATE INDEX idx_memory_updated ON memory_documents(updated_at);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tags,
  content='memory_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memory_documents_ai AFTER INSERT ON memory_documents BEGIN
  INSERT INTO memory_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;

CREATE TRIGGER memory_documents_ad AFTER DELETE ON memory_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, title, body, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
END;

CREATE TRIGGER memory_documents_au AFTER UPDATE ON memory_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, id, title, body, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
  INSERT INTO memory_fts(rowid, id, title, body, tags)
  VALUES (new.rowid, new.id, new.title, new.body, new.tags);
END;
`;

/** Ordered list of migrations. Index + 1 is the resulting `user_version`. */
const MIGRATIONS: string[] = [SCHEMA, MEMORY_SCHEMA];

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
