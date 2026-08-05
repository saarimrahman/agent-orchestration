import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import type { Project } from './types.ts';

const PALETTE = [
  '#6366f1',
  '#ec4899',
  '#14b8a6',
  '#f59e0b',
  '#8b5cf6',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
];

export function normalizeKey(key: string): string {
  const slug = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`"${key}" is not a usable project key. Use letters and digits.`);
  return slug;
}

export function listProjects(db: Db, includeArchived = false): Project[] {
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY archived_at IS NOT NULL, key'
    : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY key';
  return db.prepare(sql).all() as unknown as Project[];
}

export function getProject(db: Db, key: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE key = ?')
    .get(normalizeKey(key)) as unknown as Project | undefined;
  return row ?? null;
}

/** Look up a project, or fail with the list of keys that would have worked. */
export function requireProject(db: Db, key: string): Project {
  const project = getProject(db, key);
  if (project) return project;
  const keys = listProjects(db, true).map((p) => p.key);
  throw new Error(
    `No project "${key}".` +
      (keys.length
        ? ` Existing projects: ${keys.join(', ')}.`
        : ` Create one with: orch project add ${normalizeKey(key)}`),
  );
}

/**
 * The project used when a command omits `-p`. Falls back to $ORCH_PROJECT, then
 * to the only project if exactly one exists.
 */
export function defaultProject(db: Db): Project {
  if (process.env.ORCH_PROJECT) return requireProject(db, process.env.ORCH_PROJECT);
  const projects = listProjects(db);
  if (projects.length === 1) return projects[0];
  if (projects.length === 0) {
    throw new Error('No projects yet. Run: orch init --project <key>');
  }
  throw new Error(
    `Several projects exist (${projects.map((p) => p.key).join(', ')}), so -p is required. ` +
      `Set ORCH_PROJECT to pick a default.`,
  );
}

export function createProject(
  db: Db,
  key: string,
  name?: string,
  color?: string,
): Project {
  const slug = normalizeKey(key);
  if (getProject(db, slug)) throw new Error(`Project "${slug}" already exists.`);
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
  ).n;
  db.prepare(
    'INSERT INTO projects (key, name, color, created_at) VALUES (?, ?, ?, ?)',
  ).run(slug, name ?? key.trim(), color ?? PALETTE[count % PALETTE.length], nowIso());
  return getProject(db, slug)!;
}

export function archiveProject(db: Db, key: string, archived: boolean): Project {
  const project = requireProject(db, key);
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(
    archived ? nowIso() : null,
    project.id,
  );
  return getProject(db, project.key)!;
}
