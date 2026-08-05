import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { Db } from './db.ts';
import { nowIso, tx } from './db.ts';
import type { Project, TaskView } from './types.ts';
import { requireProject } from './projects.ts';

export const MEMORY_KINDS = [
  'fact',
  'decision',
  'pitfall',
  'playbook',
  'preference',
  'note',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ['candidate', 'active', 'superseded', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemoryDocument = {
  id: string;
  project_id: number | null;
  project_key: string | null;
  scope: 'global' | 'project';
  kind: MemoryKind;
  status: MemoryStatus;
  title: string;
  path: string;
  tags: string[];
  sources: string[];
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  review_after: string | null;
  supersedes: string | null;
  content_hash: string;
};

export type MemorySearchResult = MemoryDocument & {
  score: number;
  snippet: string;
};

export type MemoryContext = {
  pinned: { scope: 'global' | 'project'; path: string; body: string }[];
  matches: MemorySearchResult[];
};

const INDEX_BEGIN = '<!-- orch:index:begin -->';
const INDEX_END = '<!-- orch:index:end -->';

const KIND_DIRECTORIES: Record<MemoryKind, string> = {
  fact: 'facts',
  decision: 'decisions',
  pitfall: 'pitfalls',
  playbook: 'playbooks',
  preference: 'preferences',
  note: 'notes',
};

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where',
  'which', 'with', 'write', 'update', 'fix', 'add', 'make', 'task',
]);

function expandConfiguredPath(value: string, base: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(base, value);
}

/**
 * Memory is deliberately separate from the working repository by default.
 * A project can opt into another location in `.orch/config.json`, but even
 * then orch creates a nested private Git repository and never commits to an
 * enclosing source repository.
 */
export function resolveMemoryPath(cwd = process.cwd()): string {
  if (process.env.ORCH_MEMORY_DIR) {
    return expandConfiguredPath(process.env.ORCH_MEMORY_DIR, cwd);
  }

  let dir = resolve(cwd);
  for (;;) {
    const config = join(dir, '.orch', 'config.json');
    if (existsSync(config)) {
      try {
        const parsed = JSON.parse(readFileSync(config, 'utf8')) as { memory?: unknown };
        if (typeof parsed.memory === 'string' && parsed.memory.trim()) {
          return expandConfiguredPath(parsed.memory, dir);
        }
      } catch (err) {
        throw new Error(
          `Could not read ${config}: ${(err as Error).message}\n` +
            `Expected JSON shaped like {"memory": "~/.orch/memory"}.`,
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return join(homedir(), '.orch', 'memory');
}

export function memoryScopePath(root: string, project: Project | null): string {
  return project ? join(root, 'projects', project.key) : join(root, 'global');
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

function jsonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const text = value.trim();
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return inner
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text.replace(/^['"]|['"]$/g, '');
  }
}

function parseFrontmatter(raw: string, path: string): { meta: Record<string, unknown>; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) {
    throw new Error(`${path} needs YAML frontmatter beginning with "---".`);
  }

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`Could not parse frontmatter line in ${path}: ${line}`);
    meta[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1));
  }
  return { meta, content: raw.slice(match[0].length).trim() };
}

function requiredString(meta: Record<string, unknown>, key: string, path: string): string {
  const value = meta[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} needs a non-empty "${key}" field in its frontmatter.`);
  }
  return value.trim();
}

function optionalString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseMemoryFile(path: string, project: Project | null): MemoryDocument {
  const raw = readFileSync(path, 'utf8');
  const { meta, content } = parseFrontmatter(raw, path);
  const id = requiredString(meta, 'id', path);
  const title = requiredString(meta, 'title', path);
  const kind = requiredString(meta, 'kind', path) as MemoryKind;
  const status = requiredString(meta, 'status', path) as MemoryStatus;
  if (!MEMORY_KINDS.includes(kind)) {
    throw new Error(`${path} has unknown kind "${kind}". Valid: ${MEMORY_KINDS.join(', ')}.`);
  }
  if (!MEMORY_STATUSES.includes(status)) {
    throw new Error(`${path} has unknown status "${status}". Valid: ${MEMORY_STATUSES.join(', ')}.`);
  }

  const stats = statSync(path);
  const withoutHeading = content.replace(/^#\s+[^\n]+(?:\r?\n)+/, '').trim();
  return {
    id,
    project_id: project?.id ?? null,
    project_key: project?.key ?? null,
    scope: project ? 'project' : 'global',
    kind,
    status,
    title,
    path: resolve(path),
    tags: jsonList(meta.tags),
    sources: jsonList(meta.sources),
    author: optionalString(meta, 'author'),
    body: withoutHeading,
    created_at: optionalString(meta, 'created_at') ?? stats.birthtime.toISOString(),
    updated_at: optionalString(meta, 'updated_at') ?? stats.mtime.toISOString(),
    last_verified_at: optionalString(meta, 'last_verified_at'),
    review_after: optionalString(meta, 'review_after'),
    supersedes: optionalString(meta, 'supersedes'),
    content_hash: hash(raw),
  };
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
      found.push(path);
    }
  }
  return found.sort();
}

function scanMemoryScope(root: string, project: Project | null): MemoryDocument[] {
  return markdownFiles(memoryScopePath(root, project)).map((path) => parseMemoryFile(path, project));
}

function upsertMemoryDocument(db: Db, document: MemoryDocument): void {
  db.prepare(
    `INSERT INTO memory_documents
       (id, project_id, scope, kind, status, title, path, tags, sources, author, body,
        created_at, updated_at, last_verified_at, review_after, supersedes, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id, scope = excluded.scope, kind = excluded.kind,
       status = excluded.status, title = excluded.title, path = excluded.path,
       tags = excluded.tags, sources = excluded.sources, author = excluded.author,
       body = excluded.body, created_at = excluded.created_at, updated_at = excluded.updated_at,
       last_verified_at = excluded.last_verified_at, review_after = excluded.review_after,
       supersedes = excluded.supersedes, content_hash = excluded.content_hash`,
  ).run(
    document.id,
    document.project_id,
    document.scope,
    document.kind,
    document.status,
    document.title,
    document.path,
    JSON.stringify(document.tags),
    JSON.stringify(document.sources),
    document.author,
    document.body,
    document.created_at,
    document.updated_at,
    document.last_verified_at,
    document.review_after,
    document.supersedes,
    document.content_hash,
  );
}

/** Rebuild one scope's disposable SQLite index from its canonical Markdown files. */
export function syncMemoryScope(db: Db, root: string, project: Project | null): MemoryDocument[] {
  const documents = scanMemoryScope(root, project);
  const scope = project ? 'project' : 'global';
  tx(db, () => {
    db.prepare('DELETE FROM memory_documents WHERE scope = ? AND project_id IS ?').run(
      scope,
      project?.id ?? null,
    );
    for (const document of documents) upsertMemoryDocument(db, document);
  });
  return documents;
}

function rowToMemory(row: Record<string, unknown>): MemoryDocument {
  return {
    id: String(row.id),
    project_id: row.project_id === null ? null : Number(row.project_id),
    project_key: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
    scope: row.scope as 'global' | 'project',
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    title: String(row.title),
    path: String(row.path),
    tags: jsonList(JSON.parse(String(row.tags))),
    sources: jsonList(JSON.parse(String(row.sources))),
    author: row.author === null ? null : String(row.author),
    body: String(row.body),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_verified_at: row.last_verified_at === null ? null : String(row.last_verified_at),
    review_after: row.review_after === null ? null : String(row.review_after),
    supersedes: row.supersedes === null ? null : String(row.supersedes),
    content_hash: String(row.content_hash),
  };
}

function scopeSql(project: Project | null): { sql: string; params: (string | number | null)[] } {
  return project
    ? { sql: "(d.scope = 'global' OR d.project_id = ?)", params: [project.id] }
    : { sql: "d.scope = 'global'", params: [] };
}

function syncRelevantScopes(db: Db, root: string, project: Project | null): void {
  syncMemoryScope(db, root, null);
  if (project) syncMemoryScope(db, root, project);
}

export function listMemories(
  db: Db,
  root: string,
  project: Project | null,
  options: { all?: boolean; limit?: number } = {},
): MemoryDocument[] {
  syncRelevantScopes(db, root, project);
  const scope = scopeSql(project);
  const status = options.all ? '' : "AND d.status IN ('active','candidate')";
  const rows = db.prepare(
    `SELECT d.*, p.key AS project_key
     FROM memory_documents d LEFT JOIN projects p ON p.id = d.project_id
     WHERE ${scope.sql} ${status}
     ORDER BY d.scope = 'global', d.updated_at DESC, d.title
     LIMIT ?`,
  ).all(...scope.params, options.limit ?? 100) as unknown as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(terms.filter((term) => !STOP_WORDS.has(term)))].slice(0, 16);
}

function ftsQuery(query: string): string {
  return queryTerms(query).map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function searchMemories(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options: { all?: boolean; limit?: number } = {},
): MemorySearchResult[] {
  syncRelevantScopes(db, root, project);
  const match = ftsQuery(query);
  if (!match) {
    return listMemories(db, root, project, options).map((document) => ({
      ...document,
      score: 0,
      snippet: document.body.slice(0, 240),
    }));
  }

  const scope = scopeSql(project);
  const status = options.all ? '' : "AND d.status = 'active'";
  const rows = db.prepare(
    `SELECT d.*, p.key AS project_key,
            bm25(memory_fts, 0.0, 8.0, 2.0, 4.0) AS score,
            snippet(memory_fts, 2, '[', ']', '…', 28) AS snippet
     FROM memory_fts
     JOIN memory_documents d ON d.rowid = memory_fts.rowid
     LEFT JOIN projects p ON p.id = d.project_id
     WHERE memory_fts MATCH ? AND ${scope.sql} ${status}
     ORDER BY score, d.updated_at DESC
     LIMIT ?`,
  ).all(match, ...scope.params, options.limit ?? 10) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    ...rowToMemory(row),
    score: Number(row.score),
    snippet: String(row.snippet ?? ''),
  }));
}

function memoryByIdentifier(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
): MemoryDocument {
  syncRelevantScopes(db, root, project);
  const scope = scopeSql(project);
  const rows = db.prepare(
    `SELECT d.*, p.key AS project_key
     FROM memory_documents d LEFT JOIN projects p ON p.id = d.project_id
     WHERE ${scope.sql} AND (d.id = ? OR d.id LIKE ?)
     ORDER BY d.id`,
  ).all(...scope.params, identifier, `${identifier}%`) as unknown as Record<string, unknown>[];
  if (!rows.length) throw new Error(`No memory "${identifier}". Run "orch memory ls" to see what exists.`);
  if (rows.length > 1) {
    throw new Error(`Memory prefix "${identifier}" is ambiguous: ${rows.map((row) => row.id).join(', ')}.`);
  }
  return rowToMemory(rows[0]);
}

export function getMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
): MemoryDocument {
  return memoryByIdentifier(db, root, project, identifier);
}

function slug(text: string): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
  return value || 'memory';
}

function titleFromBody(body: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'Memory';
  const plain = first.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  return plain.length > 72 ? `${plain.slice(0, 71)}…` : plain;
}

function renderMemory(document: MemoryDocument): string {
  const lines = [
    '---',
    `id: ${JSON.stringify(document.id)}`,
    `title: ${JSON.stringify(document.title)}`,
    `kind: ${JSON.stringify(document.kind)}`,
    `status: ${JSON.stringify(document.status)}`,
    `scope: ${JSON.stringify(document.scope)}`,
  ];
  if (document.project_key) lines.push(`project: ${JSON.stringify(document.project_key)}`);
  lines.push(`tags: ${JSON.stringify(document.tags)}`);
  lines.push(`sources: ${JSON.stringify(document.sources)}`);
  if (document.author) lines.push(`author: ${JSON.stringify(document.author)}`);
  lines.push(`created_at: ${JSON.stringify(document.created_at)}`);
  lines.push(`updated_at: ${JSON.stringify(document.updated_at)}`);
  if (document.last_verified_at) {
    lines.push(`last_verified_at: ${JSON.stringify(document.last_verified_at)}`);
  }
  if (document.review_after) lines.push(`review_after: ${JSON.stringify(document.review_after)}`);
  if (document.supersedes) lines.push(`supersedes: ${JSON.stringify(document.supersedes)}`);
  lines.push('---', '', `# ${document.title}`, '', document.body.trim(), '');
  return lines.join('\n');
}

function indexPath(root: string, project: Project | null): string {
  return join(memoryScopePath(root, project), 'MEMORY.md');
}

function escapeLink(text: string): string {
  return text.replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function refreshMemoryIndex(root: string, project: Project | null): string {
  const scopeDir = memoryScopePath(root, project);
  const path = indexPath(root, project);
  const documents = scanMemoryScope(root, project).sort((a, b) => {
    const status = Number(a.status !== 'active') - Number(b.status !== 'active');
    return status || b.updated_at.localeCompare(a.updated_at) || a.title.localeCompare(b.title);
  });
  const entries = documents.length
    ? documents.map((document) => {
        const link = relative(scopeDir, document.path).replaceAll('\\', '/');
        return `- [${escapeLink(document.title)}](${link}) — ${document.kind}, ${document.status}`;
      }).join('\n')
    : '_No memories yet._';
  const managed = `${INDEX_BEGIN}\n${entries}\n${INDEX_END}`;
  const heading = project ? `# Memory: ${project.key}` : '# Global memory';
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : `${heading}\n\n`;
  const next = existing.includes(INDEX_BEGIN) && existing.includes(INDEX_END)
    ? existing.replace(new RegExp(`${INDEX_BEGIN}[\\s\\S]*?${INDEX_END}`), managed)
    : `${existing.trimEnd()}\n\n${managed}\n`;
  atomicWrite(path, next.endsWith('\n') ? next : `${next}\n`);
  return path;
}

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function ensurePrivateGit(root: string): boolean {
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, '.git'))) {
    const initialized = git(root, ['init', '-q']);
    if (initialized.error || initialized.status !== 0) return false;
  }
  return true;
}

function relativeGitPaths(root: string, paths: string[]): string[] {
  return [...new Set(paths.map((path) => relative(root, path)).filter((path) => path && !path.startsWith('..')))];
}

function commitMemoryChanges(root: string, paths: string[], message: string): boolean {
  if (!ensurePrivateGit(root)) return false;
  const relativePaths = relativeGitPaths(root, paths);
  if (!relativePaths.length) return false;
  const added = git(root, ['add', '-A', '--', ...relativePaths]);
  if (added.status !== 0) return false;
  if (git(root, ['diff', '--cached', '--quiet']).status === 0) return true;
  const committed = git(root, [
    '-c', 'user.name=orch',
    '-c', 'user.email=orch@local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message, '--', ...relativePaths,
  ]);
  return committed.status === 0;
}

export type RememberMemoryInput = {
  body: string;
  title?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  tags?: string[];
  sources?: string[];
  author?: string;
  lastVerifiedAt?: string | null;
  reviewAfter?: string | null;
  supersedes?: string | null;
  project: Project | null;
  version?: boolean;
};

export function rememberMemory(
  db: Db,
  root: string,
  input: RememberMemoryInput,
): MemoryDocument {
  const body = input.body.trim();
  if (!body) throw new Error('A memory needs a body.');
  const kind = input.kind ?? 'note';
  const status = input.status ?? 'active';
  if (!MEMORY_KINDS.includes(kind)) {
    throw new Error(`Unknown memory kind "${kind}". Valid: ${MEMORY_KINDS.join(', ')}.`);
  }
  if (!MEMORY_STATUSES.includes(status)) {
    throw new Error(`Unknown memory status "${status}". Valid: ${MEMORY_STATUSES.join(', ')}.`);
  }

  const id = `mem-${randomUUID()}`;
  const title = input.title?.trim() || titleFromBody(body);
  const created = nowIso();
  const scopeDir = memoryScopePath(root, input.project);
  const path = join(scopeDir, KIND_DIRECTORIES[kind], `${slug(title)}-${id.slice(4, 12)}.md`);
  const document: MemoryDocument = {
    id,
    project_id: input.project?.id ?? null,
    project_key: input.project?.key ?? null,
    scope: input.project ? 'project' : 'global',
    kind,
    status,
    title,
    path,
    tags: [...new Set(input.tags ?? [])],
    sources: [...new Set(input.sources ?? [])],
    author: input.author?.trim() || null,
    body,
    created_at: created,
    updated_at: created,
    last_verified_at: input.lastVerifiedAt ?? null,
    review_after: input.reviewAfter ?? null,
    supersedes: input.supersedes ?? null,
    content_hash: '',
  };

  atomicWrite(path, renderMemory(document));
  syncMemoryScope(db, root, input.project);
  const memoryIndex = refreshMemoryIndex(root, input.project);
  if (input.version !== false) {
    commitMemoryChanges(root, [path, memoryIndex], `memory: add ${id}`);
  }
  return memoryByIdentifier(db, root, input.project, id);
}

export type UpdateMemoryInput = {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  tags?: string[];
  sources?: string[];
  author?: string | null;
  lastVerifiedAt?: string | null;
  reviewAfter?: string | null;
  supersedes?: string | null;
  version?: boolean;
};

export function updateMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
  input: UpdateMemoryInput,
): MemoryDocument {
  const current = memoryByIdentifier(db, root, project, identifier);
  const actualProject = current.scope === 'project'
    ? requireProject(db, current.project_key ?? '')
    : null;
  const kind = input.kind ?? current.kind;
  const status = input.status ?? current.status;
  if (!MEMORY_KINDS.includes(kind)) {
    throw new Error(`Unknown memory kind "${kind}". Valid: ${MEMORY_KINDS.join(', ')}.`);
  }
  if (!MEMORY_STATUSES.includes(status)) {
    throw new Error(`Unknown memory status "${status}". Valid: ${MEMORY_STATUSES.join(', ')}.`);
  }

  const next: MemoryDocument = {
    ...current,
    project_id: actualProject?.id ?? null,
    project_key: actualProject?.key ?? null,
    title: input.title?.trim() || current.title,
    body: input.body === undefined ? current.body : input.body.trim(),
    kind,
    status,
    tags: input.tags ?? current.tags,
    sources: input.sources ?? current.sources,
    author: input.author === undefined ? current.author : input.author,
    last_verified_at: input.lastVerifiedAt === undefined ? current.last_verified_at : input.lastVerifiedAt,
    review_after: input.reviewAfter === undefined ? current.review_after : input.reviewAfter,
    supersedes: input.supersedes === undefined ? current.supersedes : input.supersedes,
    updated_at: nowIso(),
  };
  if (!next.body) throw new Error('A memory needs a body.');

  const target = kind === current.kind
    ? current.path
    : join(memoryScopePath(root, actualProject), KIND_DIRECTORIES[kind], basename(current.path));
  if (target !== current.path && existsSync(target)) {
    throw new Error(`Cannot move the memory to ${target}: that path already exists.`);
  }
  next.path = target;
  atomicWrite(target, renderMemory(next));
  if (target !== current.path) unlinkSync(current.path);

  syncMemoryScope(db, root, actualProject);
  const memoryIndex = refreshMemoryIndex(root, actualProject);
  if (input.version !== false) {
    commitMemoryChanges(root, [current.path, target, memoryIndex], `memory: update ${current.id}`);
  }
  return memoryByIdentifier(db, root, actualProject, current.id);
}

export function archiveMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
): MemoryDocument {
  return updateMemory(db, root, project, identifier, { status: 'archived' });
}

export function reindexMemories(db: Db, root: string, project: Project | null): MemoryDocument[] {
  const global = syncMemoryScope(db, root, null);
  if (existsSync(memoryScopePath(root, null))) refreshMemoryIndex(root, null);
  if (!project) return global;
  const local = syncMemoryScope(db, root, project);
  if (existsSync(memoryScopePath(root, project))) refreshMemoryIndex(root, project);
  return [...global, ...local];
}

function memoryPreamble(root: string, project: Project | null): string | null {
  const path = indexPath(root, project);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const withoutIndex = raw.replace(new RegExp(`${INDEX_BEGIN}[\\s\\S]*?${INDEX_END}`), '');
  const withoutHeading = withoutIndex.replace(/^#\s+[^\n]+(?:\r?\n)*/, '').trim();
  return withoutHeading ? withoutHeading.slice(0, 1500) : null;
}

export function memoryContextForTask(
  db: Db,
  root: string,
  task: TaskView,
  limit = 3,
): MemoryContext {
  const project = requireProject(db, task.project_key);
  const pinned: MemoryContext['pinned'] = [];
  for (const scope of [null, project] as const) {
    const body = memoryPreamble(root, scope);
    if (body) pinned.push({ scope: scope ? 'project' : 'global', path: indexPath(root, scope), body });
  }
  const query = [task.title, task.body, ...task.tags].filter(Boolean).join(' ');
  return { pinned, matches: searchMemories(db, root, project, query, { limit }) };
}

function gitOutput(root: string, args: string[]): string {
  if (!existsSync(join(root, '.git'))) return 'Memory history has not been initialized yet.';
  const result = git(root, args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || 'Git command failed.').trim());
  return String(result.stdout).trim();
}

export function memoryDiff(root: string, path?: string): string {
  const args = ['diff', '--no-ext-diff'];
  if (path) args.push('--', relative(root, path));
  const unstaged = gitOutput(root, args);
  const stagedArgs = ['diff', '--cached', '--no-ext-diff'];
  if (path) stagedArgs.push('--', relative(root, path));
  const staged = gitOutput(root, stagedArgs);
  return [unstaged, staged].filter((part) => part && !part.startsWith('Memory history')).join('\n') || 'No uncommitted memory changes.';
}

export function memoryHistory(root: string, path?: string): string {
  const args = ['log', '--oneline', '--decorate', '-20'];
  if (path) args.push('--', relative(root, path));
  return gitOutput(root, args) || 'No memory history yet.';
}

export function memoryStatus(root: string): string {
  return gitOutput(root, ['status', '--short']) || 'Memory working tree is clean.';
}

export function commitMemory(root: string, message = 'memory: save direct edits'): boolean {
  if (!ensurePrivateGit(root)) return false;
  const added = git(root, ['add', '-A']);
  if (added.status !== 0) return false;
  if (git(root, ['diff', '--cached', '--quiet']).status === 0) return true;
  return git(root, [
    '-c', 'user.name=orch',
    '-c', 'user.email=orch@local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ]).status === 0;
}
