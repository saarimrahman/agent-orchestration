import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { Db } from './db.ts';
import { nowIso, openDb, tx } from './db.ts';
import {
  configuredEmbeddingProvider,
  cosineSimilarity,
  reciprocalRankFusion,
  type EmbeddingProvider,
  type EmbeddingVector,
} from './embeddings.ts';
import { CONFIG_DIRS, envSetting } from './env.ts';
import type { Project, TaskView } from './types.ts';
import { listProjects, requireProject } from './projects.ts';

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

export const MEMORY_RELATION_TYPES = [
  'relates',
  'supports',
  'contradicts',
  'supersedes',
  'derived_from',
  'applies_to',
] as const;
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export const MEMORY_TARGET_TYPES = ['memory', 'task', 'comment', 'file', 'url'] as const;
export type MemoryTargetType = (typeof MEMORY_TARGET_TYPES)[number];

export type MemoryRelation = {
  type: MemoryRelationType;
  target_type: MemoryTargetType;
  target: string;
};

export type MemoryRelationEdge = MemoryRelation & { source_id: string };

export type MemoryDocument = {
  id: string;
  project_id: number | null;
  project_key: string | null;
  scope: 'global' | 'project';
  kind: MemoryKind;
  status: MemoryStatus;
  title: string;
  path: string;
  aliases: string[];
  tags: string[];
  sources: string[];
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  review_after: string | null;
  relations: MemoryRelation[];
  supersedes: string | null;
  /** Flat, unrecognized frontmatter fields preserved across managed rewrites. */
  extra_frontmatter: Record<string, unknown>;
  content_hash: string;
};

export type MemorySearchResult = MemoryDocument & {
  score: number;
  snippet: string;
  reasons: string[];
  explanation: string;
};

export type MemorySearchFilters = {
  kind?: MemoryKind | MemoryKind[];
  status?: MemoryStatus | MemoryStatus[];
  tag?: string | string[];
  source?: string | string[];
  verified?: boolean;
};

export type MemorySearchOptions = MemorySearchFilters & {
  all?: boolean;
  limit?: number;
  semantic?: boolean;
  graphDepth?: number;
  embeddingProvider?: EmbeddingProvider;
  /** Ranking hints; unlike tag/source filters these do not exclude other memories. */
  boostTag?: string | string[];
  boostSource?: string | string[];
};

export type MemoryContextOptions = {
  limit?: number;
  characterBudget?: number;
  graphDepth?: number;
};

export type MemoryContext = {
  pinned: { scope: 'global' | 'project'; path: string; body: string }[];
  matches: MemorySearchResult[];
};

export type MemoryBacklink = MemoryRelationEdge & { source: MemoryDocument };

export type MemoryGraph = {
  memories: MemoryDocument[];
  relations: MemoryRelationEdge[];
  truncated: boolean;
};

export type MemoryLintIssue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  memory_id: string;
  relation?: MemoryRelation;
};

export type RetrievalGoldenCase = {
  name?: string;
  query: string;
  relevant: string[];
  options?: MemorySearchOptions;
};

export type RetrievalEvaluationCase = {
  name: string;
  retrieved: string[];
  recall_at_k: number;
  reciprocal_rank: number;
  stale_hits: number;
  context_precision: number;
};

export type RetrievalEvaluation = {
  k: number;
  recall_at_k: number;
  mrr: number;
  stale_hit_rate: number;
  context_precision: number;
  cases: RetrievalEvaluationCase[];
};

export type MemoryMigrationState =
  | 'missing'
  | 'legacy_only'
  | 'current_only'
  | 'synchronized'
  | 'mergeable'
  | 'conflict';

export type MemoryMigrationConflict = {
  code: 'invalid_layout' | 'invalid_memory' | 'path_conflict' | 'duplicate_id' | 'relation_target';
  path: string;
  message: string;
};

export type MemoryMigrationInventory = {
  source: string;
  destination: string;
  state: MemoryMigrationState;
  source_exists: boolean;
  destination_exists: boolean;
  source_files: number;
  destination_files: number;
  source_memories: number;
  destination_memories: number;
  source_has_git: boolean;
  destination_has_git: boolean;
  source_only_files: string[];
  destination_only_files: string[];
  conflicts: MemoryMigrationConflict[];
};

export type MemoryMigrationOptions = {
  source?: string;
  destination?: string;
  /** Preserve and report dangling memory relations instead of refusing migration. */
  allowUnresolvedMemoryTargets?: boolean;
};

export type MemoryMigrationReport = MemoryMigrationInventory & {
  migrated: boolean;
  source_preserved: true;
  backup: string | null;
  memories: number;
  copied_files: number;
  rewritten_memories: number;
  canonicalized_relations: number;
  unresolved_relations: Array<{ memory_id: string; target: string }>;
};

const INDEX_BEGIN = '<!-- orchestration:index:begin -->';
const INDEX_END = '<!-- orchestration:index:end -->';

// Index files written before the rename carry the old markers. Reading both
// means an existing MEMORY.md is rewritten in place on the next refresh instead
// of collecting a second, competing index block.
const LEGACY_INDEX_BEGIN = '<!-- orch:index:begin -->';
const LEGACY_INDEX_END = '<!-- orch:index:end -->';
const RELATIONS_BEGIN = '<!-- orchestration:relations:begin -->';
const RELATIONS_END = '<!-- orchestration:relations:end -->';

const KNOWN_FRONTMATTER = new Set([
  'id', 'title', 'kind', 'status', 'scope', 'project', 'aliases', 'tags', 'sources',
  'author', 'created_at', 'updated_at', 'last_verified_at', 'review_after',
  'relations', 'supersedes',
]);

function indexBlockPattern(): RegExp {
  return new RegExp(
    `(?:${INDEX_BEGIN}|${LEGACY_INDEX_BEGIN})[\\s\\S]*?(?:${INDEX_END}|${LEGACY_INDEX_END})`,
  );
}

function relationsBlockPattern(): RegExp {
  return new RegExp(`${RELATIONS_BEGIN}[\\s\\S]*?${RELATIONS_END}(?:\\r?\\n)?`);
}

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

/** Stable home-based roots used by the explicit legacy-to-current migration. */
export function legacyMemoryRoot(home = homedir()): string {
  return join(home, '.orch', 'memory');
}

export function currentMemoryRoot(home = homedir()): string {
  return join(home, '.orchestration', 'memory');
}

/**
 * Memory is deliberately separate from the working repository by default.
 * A project can opt into another location in `.orchestration/config.json`, but
 * even then orchestration creates a nested private Git repository and never
 * commits to an enclosing source repository. As with the database, the older
 * `.orch` locations are still read so memory written before the rename is not
 * orphaned.
 */
export function resolveMemoryPath(cwd = process.cwd()): string {
  const configured = envSetting('MEMORY_DIR');
  if (configured) return expandConfiguredPath(configured, cwd);

  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_DIRS) {
      const config = join(dir, name, 'config.json');
      if (!existsSync(config)) continue;
      try {
        const parsed = JSON.parse(readFileSync(config, 'utf8')) as { memory?: unknown };
        if (typeof parsed.memory === 'string' && parsed.memory.trim()) {
          return expandConfiguredPath(parsed.memory, dir);
        }
      } catch (err) {
        throw new Error(
          `Could not read ${config}: ${(err as Error).message}\n` +
            `Expected JSON shaped like {"memory": "~/.orchestration/memory"}.`,
        );
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const legacy = legacyMemoryRoot();
  const current = currentMemoryRoot();
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function relationKey(relation: MemoryRelation): string {
  return `${relation.type}\0${relation.target_type}\0${relation.target}`;
}

function uniqueRelations(relations: MemoryRelation[]): MemoryRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = relationKey(relation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseRelations(value: unknown, path: string): MemoryRelation[] {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    throw new Error(`${path} needs "relations" to be a JSON array in its flat frontmatter.`);
  }
  const relations = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${path} has an invalid relations[${index}] entry.`);
    }
    const relation = entry as Record<string, unknown>;
    const type = typeof relation.type === 'string' ? relation.type.trim() : '';
    const targetType = typeof relation.target_type === 'string' ? relation.target_type.trim() : '';
    const target = typeof relation.target === 'string' ? relation.target.trim() : '';
    if (!type || !targetType || !target) {
      throw new Error(
        `${path} relations[${index}] needs non-empty "type", "target_type", and "target" fields.`,
      );
    }
    return {
      type: type as MemoryRelationType,
      target_type: targetType as MemoryTargetType,
      target,
    };
  });
  return uniqueRelations(relations);
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
  const body = withoutHeading.replace(relationsBlockPattern(), '').trim();
  const legacySupersedes = optionalString(meta, 'supersedes');
  const relations = parseRelations(meta.relations, path);
  if (legacySupersedes) {
    relations.push({ type: 'supersedes', target_type: 'memory', target: legacySupersedes });
  }
  const normalizedRelations = uniqueRelations(relations);
  const extraFrontmatter = Object.fromEntries(
    Object.entries(meta).filter(([key]) => !KNOWN_FRONTMATTER.has(key)),
  );
  return {
    id,
    project_id: project?.id ?? null,
    project_key: project?.key ?? null,
    scope: project ? 'project' : 'global',
    kind,
    status,
    title,
    path: resolve(path),
    aliases: uniqueStrings([id, ...jsonList(meta.aliases)]),
    tags: jsonList(meta.tags),
    sources: jsonList(meta.sources),
    author: optionalString(meta, 'author'),
    body,
    created_at: optionalString(meta, 'created_at') ?? stats.birthtime.toISOString(),
    updated_at: optionalString(meta, 'updated_at') ?? stats.mtime.toISOString(),
    last_verified_at: optionalString(meta, 'last_verified_at'),
    review_after: optionalString(meta, 'review_after'),
    relations: normalizedRelations,
    supersedes: normalizedRelations.find(
      (relation) => relation.type === 'supersedes' && relation.target_type === 'memory',
    )?.target ?? null,
    extra_frontmatter: extraFrontmatter,
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
       (id, project_id, scope, kind, status, title, path, aliases, tags, sources, author, body,
        created_at, updated_at, last_verified_at, review_after, relations, supersedes,
        extra_frontmatter, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id, scope = excluded.scope, kind = excluded.kind,
       status = excluded.status, title = excluded.title, path = excluded.path,
       aliases = excluded.aliases, tags = excluded.tags, sources = excluded.sources,
       author = excluded.author,
       body = excluded.body, created_at = excluded.created_at, updated_at = excluded.updated_at,
       last_verified_at = excluded.last_verified_at, review_after = excluded.review_after,
       relations = excluded.relations, supersedes = excluded.supersedes,
       extra_frontmatter = excluded.extra_frontmatter, content_hash = excluded.content_hash`,
  ).run(
    document.id,
    document.project_id,
    document.scope,
    document.kind,
    document.status,
    document.title,
    document.path,
    JSON.stringify(document.aliases),
    JSON.stringify(document.tags),
    JSON.stringify(document.sources),
    document.author,
    document.body,
    document.created_at,
    document.updated_at,
    document.last_verified_at,
    document.review_after,
    JSON.stringify(document.relations),
    document.supersedes,
    JSON.stringify(document.extra_frontmatter),
    document.content_hash,
  );

  db.prepare('DELETE FROM memory_relations WHERE source_id = ?').run(document.id);
  const insert = db.prepare(
    `INSERT INTO memory_relations (source_id, relation, target_type, target)
     VALUES (?, ?, ?, ?)`,
  );
  for (const relation of document.relations) {
    insert.run(document.id, relation.type, relation.target_type, relation.target);
  }
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
    db.prepare(
      `DELETE FROM memory_embeddings
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_documents d
         WHERE d.id = memory_embeddings.memory_id
           AND d.content_hash = memory_embeddings.content_hash
       )`,
    ).run();
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
    aliases: jsonList(JSON.parse(String(row.aliases ?? '[]'))),
    tags: jsonList(JSON.parse(String(row.tags))),
    sources: jsonList(JSON.parse(String(row.sources))),
    author: row.author === null ? null : String(row.author),
    body: String(row.body),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_verified_at: row.last_verified_at === null ? null : String(row.last_verified_at),
    review_after: row.review_after === null ? null : String(row.review_after),
    relations: parseRelations(JSON.parse(String(row.relations ?? '[]')), String(row.path)),
    supersedes: row.supersedes === null ? null : String(row.supersedes),
    extra_frontmatter: JSON.parse(String(row.extra_frontmatter ?? '{}')) as Record<string, unknown>,
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

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function includesCaseInsensitive(values: string[], expected: string): boolean {
  const normalized = expected.toLowerCase();
  return values.some((value) => value.toLowerCase() === normalized);
}

function matchesSearchFilters(document: MemoryDocument, options: MemorySearchOptions): boolean {
  const kinds = asArray(options.kind);
  if (kinds.length && !kinds.includes(document.kind)) return false;
  const statuses = asArray(options.status);
  if (statuses.length) {
    if (!statuses.includes(document.status)) return false;
  } else if (!options.all && document.status !== 'active') {
    return false;
  }
  const tags = asArray(options.tag);
  if (tags.length && !tags.every((tag) => includesCaseInsensitive(document.tags, tag))) return false;
  const sources = asArray(options.source);
  if (sources.length && !sources.every((source) => includesCaseInsensitive(document.sources, source))) {
    return false;
  }
  if (options.verified !== undefined && Boolean(document.last_verified_at) !== options.verified) {
    return false;
  }
  return true;
}

function visibleDocuments(db: Db, project: Project | null): MemoryDocument[] {
  const scope = scopeSql(project);
  const rows = db.prepare(
    `SELECT d.*, p.key AS project_key
     FROM memory_documents d LEFT JOIN projects p ON p.id = d.project_id
     WHERE ${scope.sql}
     ORDER BY d.updated_at DESC, d.id`,
  ).all(...scope.params) as unknown as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

function lexicalQueries(terms: string[]): { name: string; query: string; strong: boolean }[] {
  if (!terms.length) return [];
  const escaped = terms.map((term) => term.replaceAll('"', '""'));
  const candidates = [
    terms.length > 1
      ? { name: 'phrase', query: `"${escaped.join(' ')}"`, strong: true }
      : null,
    { name: 'all terms', query: escaped.map((term) => `"${term}"`).join(' AND '), strong: true },
    { name: 'prefix', query: escaped.map((term) => `"${term}"*`).join(' AND '), strong: false },
    { name: 'term', query: escaped.map((term) => `"${term}"`).join(' OR '), strong: false },
  ].filter((item): item is { name: string; query: string; strong: boolean } => Boolean(item));
  const seen = new Set<string>();
  return candidates.filter((item) => !seen.has(item.query) && Boolean(seen.add(item.query)));
}

function fallbackSnippet(document: MemoryDocument, terms: string[]): string {
  const text = document.body || document.title;
  if (!terms.length) return text.slice(0, 240);
  const lower = text.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 60) : 0;
  let snippet = text.slice(start, start + 240);
  for (const term of terms) {
    snippet = snippet.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})`, 'ig'), '[$1]');
  }
  return `${start > 0 ? '…' : ''}${snippet}${start + 240 < text.length ? '…' : ''}`;
}

type RetrievalState = {
  documents: MemoryDocument[];
  byId: Map<string, MemoryDocument>;
  rankings: MemoryDocument[][];
  reasons: Map<string, Set<string>>;
  snippets: Map<string, string>;
  strongSeeds: Set<string>;
  terms: string[];
};

function addReason(state: RetrievalState, id: string, reason: string): void {
  const reasons = state.reasons.get(id) ?? new Set<string>();
  reasons.add(reason);
  state.reasons.set(id, reasons);
}

function activeReplacements(documents: MemoryDocument[]): Map<string, MemoryDocument[]> {
  const replacements = new Map<string, MemoryDocument[]>();
  for (const document of documents) {
    if (document.status !== 'active') continue;
    for (const relation of document.relations) {
      if (relation.type !== 'supersedes' || relation.target_type !== 'memory') continue;
      replacements.set(relation.target, [...(replacements.get(relation.target) ?? []), document]);
    }
  }
  return replacements;
}

function prepareLexicalRetrieval(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options: MemorySearchOptions,
): RetrievalState {
  syncRelevantScopes(db, root, project);
  const documents = visibleDocuments(db, project);
  const byId = new Map(documents.map((document) => [document.id, document]));
  const state: RetrievalState = {
    documents,
    byId,
    rankings: [],
    reasons: new Map(),
    snippets: new Map(),
    strongSeeds: new Set(),
    terms: queryTerms(query),
  };
  const replacements = activeReplacements(documents);
  const explicitStatuses = asArray(options.status);
  const scope = scopeSql(project);
  const candidateLimit = Math.max(50, (options.limit ?? 10) * 10);
  for (const strategy of lexicalQueries(state.terms)) {
    const rows = db.prepare(
      `SELECT d.*, p.key AS project_key,
              bm25(memory_fts, 0.0, 8.0, 2.0, 4.0) AS lexical_score,
              snippet(memory_fts, 2, '[', ']', '…', 28) AS lexical_snippet
       FROM memory_fts
       JOIN memory_documents d ON d.rowid = memory_fts.rowid
       LEFT JOIN projects p ON p.id = d.project_id
       WHERE memory_fts MATCH ? AND ${scope.sql}
       ORDER BY lexical_score, d.updated_at DESC
       LIMIT ?`,
    ).all(strategy.query, ...scope.params, candidateLimit) as unknown as Record<string, unknown>[];
    const ranking: MemoryDocument[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const hit = rowToMemory(row);
      const redirected = hit.status === 'superseded' && !explicitStatuses.length
        ? replacements.get(hit.id) ?? []
        : [hit];
      for (const document of redirected) {
        if (seen.has(document.id) || !matchesSearchFilters(document, options)) continue;
        seen.add(document.id);
        ranking.push(document);
        state.snippets.set(document.id, String(row.lexical_snippet ?? ''));
        if (document.id !== hit.id) {
          addReason(state, document.id, `active replacement for superseded memory “${hit.title}”`);
        }
        addReason(state, document.id, `${strategy.name} lexical match`);
        if (strategy.strong) state.strongSeeds.add(document.id);
      }
    }
    if (ranking.length) state.rankings.push(ranking);
  }
  const boostedSources = asArray(options.boostSource);
  if (boostedSources.length) {
    const ranking = documents.filter((document) =>
      matchesSearchFilters(document, options) &&
      boostedSources.some((source) => includesCaseInsensitive(document.sources, source)));
    if (ranking.length) {
      state.rankings.unshift(ranking);
      for (const document of ranking) {
        const matches = boostedSources.filter((source) => includesCaseInsensitive(document.sources, source));
        addReason(state, document.id, `exact source match: ${matches.join(', ')}`);
        state.strongSeeds.add(document.id);
      }
    }
  }
  const boostedTags = asArray(options.boostTag);
  if (boostedTags.length) {
    const ranking = documents.filter((document) =>
      matchesSearchFilters(document, options) &&
      boostedTags.some((tag) => includesCaseInsensitive(document.tags, tag)));
    if (ranking.length) {
      state.rankings.unshift(ranking);
      for (const document of ranking) {
        const matches = boostedTags.filter((tag) => includesCaseInsensitive(document.tags, tag));
        addReason(state, document.id, `exact tag match: ${matches.join(', ')}`);
      }
    }
  }
  return state;
}

function expandGraph(state: RetrievalState, options: MemorySearchOptions): void {
  const depth = Math.min(3, Math.max(0, Math.floor(options.graphDepth ?? 0)));
  if (!depth || !state.strongSeeds.size) return;
  const aliasToId = new Map<string, string>();
  for (const document of state.documents) {
    aliasToId.set(document.id, document.id);
    for (const alias of document.aliases) aliasToId.set(alias, document.id);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const document of state.documents) {
    for (const relation of document.relations) {
      if (relation.target_type !== 'memory') continue;
      const target = aliasToId.get(relation.target);
      if (!target) continue;
      (adjacency.get(document.id) ?? adjacency.set(document.id, new Set()).get(document.id)!).add(target);
      (adjacency.get(target) ?? adjacency.set(target, new Set()).get(target)!).add(document.id);
    }
  }
  const distance = new Map<string, number>();
  const origin = new Map<string, string>();
  const queue: string[] = [];
  for (const seed of [...state.strongSeeds].slice(0, 5)) {
    distance.set(seed, 0);
    origin.set(seed, seed);
    queue.push(seed);
  }
  while (queue.length && distance.size <= 100) {
    const id = queue.shift()!;
    const currentDistance = distance.get(id)!;
    if (currentDistance >= depth) continue;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, currentDistance + 1);
      origin.set(neighbor, origin.get(id) ?? id);
      queue.push(neighbor);
    }
  }
  const graphRanking = [...distance.entries()]
    .filter(([id, hops]) => hops > 0 && matchesSearchFilters(state.byId.get(id)!, options))
    .sort((left, right) => left[1] - right[1])
    .map(([id, hops]) => {
      const seed = state.byId.get(origin.get(id) ?? '');
      addReason(state, id, `connected ${hops} graph hop${hops === 1 ? '' : 's'} from “${seed?.title ?? 'a strong match'}”`);
      return state.byId.get(id)!;
    });
  if (graphRanking.length) state.rankings.push(graphRanking);
}

function qualityBoost(document: MemoryDocument, state: RetrievalState, options: MemorySearchOptions): number {
  let boost = 0;
  if (document.status === 'active') boost += 0.002;
  if (document.last_verified_at) {
    boost += 0.004;
    addReason(state, document.id, 'verified memory');
  }
  const age = Date.now() - new Date(document.updated_at).getTime();
  if (Number.isFinite(age) && age <= 180 * 24 * 60 * 60 * 1_000) {
    boost += 0.002;
    addReason(state, document.id, 'recently updated');
  }
  if (document.sources.length) {
    boost += Math.min(0.003, document.sources.length * 0.001);
    addReason(state, document.id, `${document.sources.length} provenance source${document.sources.length === 1 ? '' : 's'}`);
  }
  const tagHints = [...asArray(options.tag), ...asArray(options.boostTag)];
  const exactTags = document.tags.filter((tag) =>
    state.terms.includes(tag.toLowerCase()) || tagHints.some((value) => value.toLowerCase() === tag.toLowerCase()));
  if (exactTags.length) {
    boost += 0.03;
    addReason(state, document.id, `exact tag match: ${exactTags.join(', ')}`);
  }
  const sourceHints = [...asArray(options.source), ...asArray(options.boostSource)];
  const exactSources = document.sources.filter((source) =>
    sourceHints.some((value) => value.toLowerCase() === source.toLowerCase()));
  if (exactSources.length) {
    boost += 0.3;
    addReason(state, document.id, `exact source match: ${exactSources.join(', ')}`);
  }
  return boost;
}

function finishRetrieval(state: RetrievalState, options: MemorySearchOptions): MemorySearchResult[] {
  expandGraph(state, options);
  if (!state.rankings.length && !state.terms.length) {
    const fallback = state.documents.filter((document) => matchesSearchFilters(document, options));
    if (fallback.length) {
      state.rankings.push(fallback);
      for (const document of fallback) addReason(state, document.id, 'recent memory fallback');
    }
  }
  const fused = reciprocalRankFusion(state.rankings, { k: 20, key: (document) => document.id });
  return fused
    .map(({ item, score }) => {
      const finalScore = -(score + qualityBoost(item, state, options));
      const reasons = [...(state.reasons.get(item.id) ?? ['retrieval match'])];
      return {
        ...item,
        score: finalScore,
        snippet: state.snippets.get(item.id) || fallbackSnippet(item, state.terms),
        reasons,
        explanation: reasons.join('; '),
      };
    })
    .sort((left, right) => left.score - right.score || right.updated_at.localeCompare(left.updated_at))
    .slice(0, options.limit ?? 10);
}

function embeddingText(document: MemoryDocument): string {
  return [document.title, document.tags.join(' '), document.sources.join(' '), document.body]
    .filter(Boolean)
    .join('\n');
}

function cachedEmbedding(db: Db, document: MemoryDocument, provider: string): EmbeddingVector | null {
  const row = db.prepare(
    `SELECT dimensions, vector FROM memory_embeddings
     WHERE memory_id = ? AND provider = ? AND content_hash = ?`,
  ).get(document.id, provider, document.content_hash) as { dimensions: number; vector: string } | undefined;
  if (!row) return null;
  const vector = JSON.parse(row.vector) as unknown;
  if (!Array.isArray(vector) || vector.length !== Number(row.dimensions) ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    db.prepare(
      'DELETE FROM memory_embeddings WHERE memory_id = ? AND provider = ? AND content_hash = ?',
    ).run(document.id, provider, document.content_hash);
    return null;
  }
  return vector as number[];
}

function storeEmbedding(
  db: Db,
  document: MemoryDocument,
  provider: string,
  vector: EmbeddingVector,
): void {
  db.prepare(
    `INSERT INTO memory_embeddings
       (memory_id, provider, content_hash, dimensions, vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_id, provider, content_hash) DO UPDATE SET
       dimensions = excluded.dimensions, vector = excluded.vector, created_at = excluded.created_at`,
  ).run(
    document.id,
    provider,
    document.content_hash,
    vector.length,
    JSON.stringify(vector),
    nowIso(),
  );
}

async function addSemanticRanking(
  db: Db,
  state: RetrievalState,
  query: string,
  options: MemorySearchOptions,
): Promise<void> {
  const provider = options.embeddingProvider ?? configuredEmbeddingProvider();
  if (!provider) {
    throw new Error(
      'Semantic memory search needs an embedding provider. Set ' +
      'ORCHESTRATION_EMBEDDING_COMMAND to a JSON argv array such as ["python3","./embed.py"].',
    );
  }
  const queryVectors = await provider.embed([query]);
  const queryVector = queryVectors[0];
  if (!queryVector) throw new Error('Embedding provider did not return a query vector.');
  const providerCacheKey = `${provider.kind}:dim-${queryVector.length}`;
  const candidates = state.documents.filter((document) => matchesSearchFilters(document, options));
  const cached = new Map<string, EmbeddingVector>();
  const missing: MemoryDocument[] = [];
  for (const document of candidates) {
    const vector = cachedEmbedding(db, document, providerCacheKey);
    if (vector) cached.set(document.id, vector);
    else missing.push(document);
  }
  const vectors = missing.length ? await provider.embed(missing.map(embeddingText)) : [];
  tx(db, () => {
    missing.forEach((document, index) => {
      const vector = vectors[index];
      if (!vector) throw new Error(`Embedding provider omitted document vector ${index}.`);
      if (vector.length !== queryVector.length) {
        throw new Error(
          `Embedding provider returned document dimension ${vector.length}; ` +
          `the query dimension is ${queryVector.length}.`,
        );
      }
      storeEmbedding(db, document, providerCacheKey, vector);
      cached.set(document.id, vector);
    });
  });
  const scored = candidates.map((document) => ({
    document,
    similarity: cosineSimilarity(queryVector, cached.get(document.id)!),
  })).sort((left, right) => right.similarity - left.similarity);
  const ranking = scored.filter((item) => item.similarity > 0).map(({ document, similarity }) => {
    addReason(state, document.id, `semantic similarity ${similarity.toFixed(3)}`);
    if (similarity >= 0.65) state.strongSeeds.add(document.id);
    return document;
  });
  if (ranking.length) state.rankings.push(ranking);
}

export function searchMemories(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options: MemorySearchOptions & { semantic: true },
): Promise<MemorySearchResult[]>;
export function searchMemories(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options?: MemorySearchOptions & { semantic?: false },
): MemorySearchResult[];
export function searchMemories(
  db: Db,
  root: string,
  project: Project | null,
  query: string,
  options: MemorySearchOptions = {},
): MemorySearchResult[] | Promise<MemorySearchResult[]> {
  const state = prepareLexicalRetrieval(db, root, project, query, options);
  if (options.semantic) {
    return addSemanticRanking(db, state, query, options).then(() => finishRetrieval(state, options));
  }
  return finishRetrieval(state, options);
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
     WHERE ${scope.sql} AND (
       d.id = ? OR d.id LIKE ? OR
       EXISTS (SELECT 1 FROM json_each(d.aliases) a WHERE a.value = ?)
     )
     ORDER BY d.id`,
  ).all(...scope.params, identifier, `${identifier}%`, identifier) as unknown as Record<string, unknown>[];
  if (!rows.length) throw new Error(`No memory "${identifier}". Run "orchestration memory ls" to see what exists.`);
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

function renderFrontmatterValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? JSON.stringify(String(value)) : rendered;
}

function relationDisplay(relation: MemoryRelation): string {
  const target = relation.target.replaceAll('[[', '').replaceAll(']]', '').replaceAll('|', '\\|');
  if (relation.target_type === 'url') {
    return `[${target.replaceAll(']', '\\]')}](${relation.target})`;
  }
  if (relation.target_type === 'memory' || relation.target_type === 'file') {
    return `[[${target}]]`;
  }
  return `\`${relation.target_type}:${target.replaceAll('`', '\\`')}\``;
}

function renderRelationsBlock(relations: MemoryRelation[]): string {
  if (!relations.length) return '';
  const entries = relations.map(
    (relation) => `- **${relation.type}** ${relationDisplay(relation)}`,
  );
  return [RELATIONS_BEGIN, '## Related', '', ...entries, RELATIONS_END].join('\n');
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
  lines.push(`aliases: ${JSON.stringify(uniqueStrings([document.id, ...document.aliases]))}`);
  lines.push(`tags: ${JSON.stringify(document.tags)}`);
  lines.push(`sources: ${JSON.stringify(document.sources)}`);
  if (document.author) lines.push(`author: ${JSON.stringify(document.author)}`);
  lines.push(`created_at: ${JSON.stringify(document.created_at)}`);
  lines.push(`updated_at: ${JSON.stringify(document.updated_at)}`);
  if (document.last_verified_at) {
    lines.push(`last_verified_at: ${JSON.stringify(document.last_verified_at)}`);
  }
  if (document.review_after) lines.push(`review_after: ${JSON.stringify(document.review_after)}`);
  if (document.relations.length) lines.push(`relations: ${JSON.stringify(document.relations)}`);
  if (document.supersedes) lines.push(`supersedes: ${JSON.stringify(document.supersedes)}`);
  for (const [key, value] of Object.entries(document.extra_frontmatter)) {
    if (!KNOWN_FRONTMATTER.has(key)) lines.push(`${key}: ${renderFrontmatterValue(value)}`);
  }
  lines.push('---', '', `# ${document.title}`, '', document.body.trim());
  const relations = renderRelationsBlock(document.relations);
  if (relations) lines.push('', relations);
  lines.push('');
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
  const next = indexBlockPattern().test(existing)
    ? existing.replace(indexBlockPattern(), managed)
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
    '-c', 'user.name=orchestration',
    '-c', 'user.email=orchestration@local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message, '--', ...relativePaths,
  ]);
  return committed.status === 0;
}

function projectForMemory(db: Db, document: MemoryDocument): Project | null {
  return document.scope === 'project' ? requireProject(db, document.project_key ?? '') : null;
}

function assertRelationShape(relation: MemoryRelation): void {
  if (!MEMORY_RELATION_TYPES.includes(relation.type)) {
    throw new Error(
      `Unknown memory relation "${relation.type}". Valid: ${MEMORY_RELATION_TYPES.join(', ')}.`,
    );
  }
  if (!MEMORY_TARGET_TYPES.includes(relation.target_type)) {
    throw new Error(
      `Unknown memory target type "${relation.target_type}". Valid: ${MEMORY_TARGET_TYPES.join(', ')}.`,
    );
  }
  if (!relation.target.trim()) throw new Error('A memory relation needs a target.');
}

function supersedesPathExists(db: Db, from: string, target: string): boolean {
  const row = db.prepare(
    `WITH RECURSIVE chain(id) AS (
       SELECT ?
       UNION
       SELECT r.target
       FROM memory_relations r JOIN chain c ON r.source_id = c.id
       WHERE r.relation = 'supersedes' AND r.target_type = 'memory'
     )
     SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`,
  ).get(from, target) as { found?: number } | undefined;
  return Boolean(row?.found);
}

function canonicalRelation(
  db: Db,
  root: string,
  project: Project | null,
  source: MemoryDocument,
  relation: MemoryRelation,
): MemoryRelation {
  assertRelationShape(relation);
  const normalized: MemoryRelation = { ...relation, target: relation.target.trim() };
  if (normalized.target_type === 'memory') {
    const target = memoryByIdentifier(db, root, project, normalized.target);
    if (target.id === source.id) throw new Error(`Memory ${source.id} cannot link to itself.`);
    normalized.target = target.id;
    if (normalized.type === 'supersedes') {
      if (target.scope !== source.scope || target.project_id !== source.project_id) {
        throw new Error('A superseding memory must be in the same scope as the memory it replaces.');
      }
      if (supersedesPathExists(db, target.id, source.id)) {
        throw new Error(`Superseding ${target.id} from ${source.id} would create a cycle.`);
      }
    }
    return normalized;
  }

  if (normalized.target_type === 'task') {
    const task = db.prepare('SELECT ref FROM tasks WHERE ref = ?').get(normalized.target);
    if (!task) throw new Error(`No task "${normalized.target}".`);
  } else if (normalized.target_type === 'comment') {
    const id = Number(normalized.target);
    const comment = Number.isInteger(id)
      ? db.prepare('SELECT id FROM comments WHERE id = ?').get(id)
      : undefined;
    if (!comment) throw new Error(`No comment "${normalized.target}". Use its numeric id.`);
  } else if (normalized.target_type === 'file') {
    const path = resolve(normalized.target);
    if (!existsSync(path)) throw new Error(`No file "${normalized.target}".`);
    normalized.target = path;
  } else if (normalized.target_type === 'url') {
    let url: URL;
    try {
      url = new URL(normalized.target);
    } catch {
      throw new Error(`Invalid URL "${normalized.target}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Memory URLs must use http or https: "${normalized.target}".`);
    }
    normalized.target = url.toString();
  }
  return normalized;
}

function persistMemoryDocuments(
  db: Db,
  root: string,
  documents: MemoryDocument[],
  removePaths: string[],
  options: { version: boolean; message: string },
): void {
  const projects = new Map<string, Project | null>();
  for (const document of documents) {
    const project = projectForMemory(db, document);
    projects.set(project ? `project:${project.id}` : 'global', project);
  }
  const indexes = [...projects.values()].map((project) => indexPath(root, project));
  const paths = uniqueStrings([
    ...documents.map((document) => document.path),
    ...removePaths,
    ...indexes,
  ]);
  const previous = new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path, 'utf8') : null]));
  try {
    for (const document of documents) atomicWrite(document.path, renderMemory(document));
    for (const path of removePaths) {
      if (!documents.some((document) => document.path === path) && existsSync(path)) unlinkSync(path);
    }
    tx(db, () => {
      for (const project of projects.values()) syncMemoryScope(db, root, project);
    });
    for (const project of projects.values()) refreshMemoryIndex(root, project);
    if (options.version) {
      commitMemoryChanges(root, paths, options.message);
    }
  } catch (error) {
    for (const [path, raw] of previous) {
      if (raw === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        atomicWrite(path, raw);
      }
    }
    tx(db, () => {
      for (const project of projects.values()) syncMemoryScope(db, root, project);
    });
    throw error;
  }
}

function supersededTargetDocuments(
  db: Db,
  root: string,
  project: Project | null,
  source: MemoryDocument,
  relations: MemoryRelation[],
): MemoryDocument[] {
  const changed: MemoryDocument[] = [];
  for (const relation of relations) {
    if (relation.type !== 'supersedes' || relation.target_type !== 'memory') continue;
    const target = memoryByIdentifier(db, root, project, relation.target);
    changed.push({ ...target, status: 'superseded', updated_at: nowIso() });
  }
  if (changed.length) source.status = 'active';
  return changed;
}

export type RememberMemoryInput = {
  body: string;
  title?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  aliases?: string[];
  tags?: string[];
  sources?: string[];
  author?: string;
  lastVerifiedAt?: string | null;
  reviewAfter?: string | null;
  relations?: MemoryRelation[];
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
    aliases: uniqueStrings([id, ...(input.aliases ?? [])]),
    tags: [...new Set(input.tags ?? [])],
    sources: [...new Set(input.sources ?? [])],
    author: input.author?.trim() || null,
    body,
    created_at: created,
    updated_at: created,
    last_verified_at: input.lastVerifiedAt ?? null,
    review_after: input.reviewAfter ?? null,
    relations: uniqueRelations([
      ...(input.relations ?? []),
      ...(input.supersedes
        ? [{ type: 'supersedes', target_type: 'memory', target: input.supersedes } as const]
        : []),
    ]),
    supersedes: input.supersedes ?? input.relations?.find(
      (relation) => relation.type === 'supersedes' && relation.target_type === 'memory',
    )?.target ?? null,
    extra_frontmatter: {},
    content_hash: '',
  };

  syncRelevantScopes(db, root, input.project);
  document.relations = uniqueRelations(document.relations.map(
    (relation) => canonicalRelation(db, root, input.project, document, relation),
  ));
  document.supersedes = document.relations.find(
    (relation) => relation.type === 'supersedes' && relation.target_type === 'memory',
  )?.target ?? null;
  const targets = supersededTargetDocuments(
    db,
    root,
    input.project,
    document,
    document.relations,
  );
  persistMemoryDocuments(
    db,
    root,
    [document, ...targets],
    [],
    { version: input.version !== false, message: `memory: add ${id}` },
  );
  return memoryByIdentifier(db, root, input.project, id);
}

export type UpdateMemoryInput = {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  aliases?: string[];
  tags?: string[];
  sources?: string[];
  author?: string | null;
  lastVerifiedAt?: string | null;
  reviewAfter?: string | null;
  relations?: MemoryRelation[];
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
    aliases: input.aliases === undefined
      ? current.aliases
      : uniqueStrings([current.id, ...input.aliases]),
    tags: input.tags ?? current.tags,
    sources: input.sources ?? current.sources,
    author: input.author === undefined ? current.author : input.author,
    last_verified_at: input.lastVerifiedAt === undefined ? current.last_verified_at : input.lastVerifiedAt,
    review_after: input.reviewAfter === undefined ? current.review_after : input.reviewAfter,
    relations: input.relations ?? (input.supersedes === undefined
      ? current.relations
      : uniqueRelations([
          ...current.relations.filter((relation) => relation.type !== 'supersedes'),
          ...(input.supersedes
            ? [{ type: 'supersedes', target_type: 'memory', target: input.supersedes } as const]
            : []),
        ])),
    supersedes: input.supersedes === undefined
      ? current.supersedes
      : input.supersedes,
    updated_at: nowIso(),
  };
  next.relations = uniqueRelations(next.relations);
  next.relations = next.relations.map(
    (relation) => canonicalRelation(db, root, actualProject, next, relation),
  );
  next.supersedes = next.relations.find(
    (relation) => relation.type === 'supersedes' && relation.target_type === 'memory',
  )?.target ?? null;
  if (!next.body) throw new Error('A memory needs a body.');

  const target = kind === current.kind
    ? current.path
    : join(memoryScopePath(root, actualProject), KIND_DIRECTORIES[kind], basename(current.path));
  if (target !== current.path && existsSync(target)) {
    throw new Error(`Cannot move the memory to ${target}: that path already exists.`);
  }
  next.path = target;
  const relationMutation = input.relations !== undefined || input.supersedes !== undefined;
  const superseded = relationMutation
    ? supersededTargetDocuments(db, root, actualProject, next, next.relations)
    : [];
  persistMemoryDocuments(
    db,
    root,
    [next, ...superseded],
    target === current.path ? [] : [current.path],
    { version: input.version !== false, message: `memory: update ${current.id}` },
  );
  return memoryByIdentifier(db, root, actualProject, current.id);
}

/** Add a typed relation to canonical Markdown and update the disposable index. */
export function linkMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
  relation: MemoryRelation,
  options: { version?: boolean } = {},
): MemoryDocument {
  const current = memoryByIdentifier(db, root, project, identifier);
  const actualProject = projectForMemory(db, current);
  const normalized = canonicalRelation(db, root, actualProject, current, relation);
  if (current.relations.some((item) => relationKey(item) === relationKey(normalized))) return current;
  return updateMemory(db, root, actualProject, current.id, {
    relations: [...current.relations, normalized],
    version: options.version,
  });
}

/** Remove one exact typed relation. Superseded targets are deliberately not revived. */
export function unlinkMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
  relation: MemoryRelation,
  options: { version?: boolean } = {},
): MemoryDocument {
  assertRelationShape(relation);
  const current = memoryByIdentifier(db, root, project, identifier);
  const actualProject = projectForMemory(db, current);
  let target = relation.target.trim();
  if (relation.target_type === 'memory') {
    try {
      target = memoryByIdentifier(db, root, actualProject, target).id;
    } catch {
      // A dangling relation must remain removable after its target is deleted.
    }
  } else if (relation.target_type === 'file') {
    target = resolve(target);
  } else if (relation.target_type === 'url') {
    try { target = new URL(target).toString(); } catch { /* match the raw value */ }
  }
  const key = relationKey({ ...relation, target });
  const relations = current.relations.filter((item) => relationKey(item) !== key);
  if (relations.length === current.relations.length) {
    throw new Error(`Memory ${current.id} does not have that relation.`);
  }
  return updateMemory(db, root, actualProject, current.id, {
    relations,
    version: options.version,
  });
}

/** Find incoming relations through the normalized SQLite backlink index. */
export function memoryBacklinks(
  db: Db,
  root: string,
  project: Project | null,
  targetType: MemoryTargetType,
  target: string,
): MemoryBacklink[] {
  syncRelevantScopes(db, root, project);
  if (!MEMORY_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Unknown memory target type "${targetType}".`);
  }
  let targets = [target.trim()];
  if (targetType === 'memory') {
    try {
      const memory = memoryByIdentifier(db, root, project, target);
      targets = uniqueStrings([memory.id, ...memory.aliases]);
    } catch {
      // Exact lookup still makes dangling backlinks inspectable.
    }
  } else if (targetType === 'file') {
    targets = [resolve(target)];
  } else if (targetType === 'url') {
    try { targets = [new URL(target).toString()]; } catch { /* query the raw value */ }
  }
  const placeholders = targets.map(() => '?').join(', ');
  const scope = scopeSql(project);
  const rows = db.prepare(
    `SELECT d.*, p.key AS project_key,
            r.relation AS edge_relation, r.target_type AS edge_target_type,
            r.target AS edge_target
     FROM memory_relations r
     JOIN memory_documents d ON d.id = r.source_id
     LEFT JOIN projects p ON p.id = d.project_id
     WHERE ${scope.sql} AND r.target_type = ? AND r.target IN (${placeholders})
     ORDER BY d.updated_at DESC, d.id`,
  ).all(...scope.params, targetType, ...targets) as unknown as Record<string, unknown>[];
  return rows.map((row) => ({
    source_id: String(row.id),
    type: String(row.edge_relation) as MemoryRelationType,
    target_type: String(row.edge_target_type) as MemoryTargetType,
    target: String(row.edge_target),
    source: rowToMemory(row),
  }));
}

/** Return a bounded, bidirectional neighborhood around one memory. */
export function memoryGraph(
  db: Db,
  root: string,
  project: Project | null,
  identifier?: string,
  options: { depth?: number; limit?: number } = {},
): MemoryGraph {
  const all = listMemories(db, root, project, { all: true, limit: 10_000 });
  const byId = new Map(all.map((memory) => [memory.id, memory]));
  const aliasToId = new Map<string, string>();
  for (const memory of all) {
    aliasToId.set(memory.id, memory.id);
    for (const alias of memory.aliases) aliasToId.set(alias, memory.id);
  }
  const edges = all.flatMap((memory) => memory.relations.map(
    (relation): MemoryRelationEdge => ({ source_id: memory.id, ...relation }),
  ));
  if (!identifier) {
    const limit = Math.max(1, Math.floor(options.limit ?? 200));
    const memories = all.slice(0, limit);
    const ids = new Set(memories.map((memory) => memory.id));
    return {
      memories,
      relations: edges.filter((edge) => ids.has(edge.source_id)),
      truncated: all.length > limit,
    };
  }

  const start = memoryByIdentifier(db, root, project, identifier);
  const depth = Math.max(0, options.depth ?? 2);
  const limit = Math.max(1, options.limit ?? 200);
  const distances = new Map([[start.id, 0]]);
  const queue = [start.id];
  let truncated = false;
  while (queue.length) {
    const id = queue.shift()!;
    const distance = distances.get(id)!;
    if (distance >= depth) continue;
    const neighbors = new Set<string>();
    for (const edge of edges) {
      if (edge.target_type !== 'memory') continue;
      const targetId = aliasToId.get(edge.target);
      if (edge.source_id === id && targetId) neighbors.add(targetId);
      if (targetId === id) neighbors.add(edge.source_id);
    }
    for (const neighbor of neighbors) {
      if (distances.has(neighbor)) continue;
      if (distances.size >= limit) {
        truncated = true;
        continue;
      }
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  const ids = new Set(distances.keys());
  return {
    memories: [...ids].map((id) => byId.get(id)).filter((item): item is MemoryDocument => Boolean(item)),
    relations: edges.filter((edge) => ids.has(edge.source_id)),
    truncated,
  };
}

/** Audit canonical memories without mutating them. */
export function lintMemories(
  db: Db,
  root: string,
  project: Project | null,
): MemoryLintIssue[] {
  const memories = listMemories(db, root, project, { all: true, limit: 10_000 });
  const issues: MemoryLintIssue[] = [];
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const aliasToIds = new Map<string, string[]>();
  for (const memory of memories) {
    for (const alias of uniqueStrings([memory.id, ...memory.aliases])) {
      aliasToIds.set(alias, [...(aliasToIds.get(alias) ?? []), memory.id]);
    }
  }
  for (const [alias, ids] of aliasToIds) {
    if (new Set(ids).size <= 1) continue;
    for (const id of new Set(ids)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_alias',
        memory_id: id,
        message: `Alias "${alias}" is shared by ${[...new Set(ids)].join(', ')}.`,
      });
    }
  }

  const resolveMemory = (target: string): MemoryDocument | undefined => {
    const ids = aliasToIds.get(target);
    return ids?.length === 1 ? byId.get(ids[0]) : undefined;
  };
  for (const memory of memories) {
    for (const relation of memory.relations) {
      if (!MEMORY_RELATION_TYPES.includes(relation.type)) {
        issues.push({ severity: 'error', code: 'invalid_relation', memory_id: memory.id,
          relation, message: `Unknown relation type "${relation.type}".` });
        continue;
      }
      if (!MEMORY_TARGET_TYPES.includes(relation.target_type)) {
        issues.push({ severity: 'error', code: 'invalid_target_type', memory_id: memory.id,
          relation, message: `Unknown target type "${relation.target_type}".` });
        continue;
      }
      let exists = true;
      let targetMemory: MemoryDocument | undefined;
      if (relation.target_type === 'memory') {
        targetMemory = resolveMemory(relation.target);
        exists = Boolean(targetMemory);
        if (targetMemory?.id === memory.id) {
          issues.push({ severity: 'error', code: 'self_relation', memory_id: memory.id,
            relation, message: 'A memory cannot link to itself.' });
        }
      } else if (relation.target_type === 'task') {
        exists = Boolean(db.prepare('SELECT 1 FROM tasks WHERE ref = ?').get(relation.target));
      } else if (relation.target_type === 'comment') {
        const id = Number(relation.target);
        exists = Number.isInteger(id) && Boolean(db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id));
      } else if (relation.target_type === 'file') {
        exists = existsSync(resolve(relation.target));
      } else if (relation.target_type === 'url') {
        try {
          const url = new URL(relation.target);
          exists = url.protocol === 'http:' || url.protocol === 'https:';
        } catch { exists = false; }
      }
      if (!exists) {
        issues.push({ severity: 'error', code: 'missing_target', memory_id: memory.id,
          relation, message: `Missing ${relation.target_type} target "${relation.target}".` });
      }
      if (relation.type === 'supersedes' && targetMemory) {
        if (memory.status !== 'active') {
          issues.push({ severity: 'error', code: 'inactive_replacement', memory_id: memory.id,
            relation, message: 'A superseding memory must be active.' });
        }
        if (targetMemory.status !== 'superseded') {
          issues.push({ severity: 'error', code: 'active_superseded_target', memory_id: memory.id,
            relation, message: `Superseded target ${targetMemory.id} is still ${targetMemory.status}.` });
        }
      }
    }
  }

  const supersedes = new Map<string, string[]>();
  for (const memory of memories) {
    supersedes.set(memory.id, memory.relations
      .filter((relation) => relation.type === 'supersedes' && relation.target_type === 'memory')
      .map((relation) => resolveMemory(relation.target)?.id)
      .filter((id): id is string => Boolean(id)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const target of supersedes.get(id) ?? []) {
      if (visiting.has(target)) {
        const start = stack.indexOf(target);
        for (const member of stack.slice(start)) cyclic.add(member);
      } else {
        visit(target);
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of supersedes.keys()) visit(id);
  for (const id of cyclic) {
    issues.push({ severity: 'error', code: 'supersedes_cycle', memory_id: id,
      message: `Memory ${id} participates in a supersedes cycle.` });
  }
  return issues.sort((a, b) => a.memory_id.localeCompare(b.memory_id) || a.code.localeCompare(b.code));
}

export function archiveMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
): MemoryDocument {
  return updateMemory(db, root, project, identifier, { status: 'archived' });
}

export function deleteMemory(
  db: Db,
  root: string,
  project: Project | null,
  identifier: string,
): MemoryDocument {
  const current = memoryByIdentifier(db, root, project, identifier);
  const actualProject = current.scope === 'project'
    ? requireProject(db, current.project_key ?? '')
    : null;

  unlinkSync(current.path);
  syncMemoryScope(db, root, actualProject);
  const memoryIndex = refreshMemoryIndex(root, actualProject);
  commitMemoryChanges(root, [current.path, memoryIndex], `memory: delete ${current.id}`);
  return current;
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
  const withoutIndex = raw.replace(indexBlockPattern(), '');
  const withoutHeading = withoutIndex.replace(/^#\s+[^\n]+(?:\r?\n)*/, '').trim();
  return withoutHeading ? withoutHeading.slice(0, 1500) : null;
}

export function memoryContextForTask(
  db: Db,
  root: string,
  task: TaskView,
  limitOrOptions: number | MemoryContextOptions = {},
): MemoryContext {
  const options = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions }
    : limitOrOptions;
  const limit = Math.max(1, Math.floor(options.limit ?? 8));
  const characterBudget = Math.max(0, Math.floor(options.characterBudget ?? 3_000));
  const project = requireProject(db, task.project_key);
  const pinned: MemoryContext['pinned'] = [];
  for (const scope of [null, project] as const) {
    const body = memoryPreamble(root, scope);
    if (body) pinned.push({ scope: scope ? 'project' : 'global', path: indexPath(root, scope), body });
  }
  const query = [task.title, task.body, ...task.tags].filter(Boolean).join(' ');
  const candidates = searchMemories(db, root, project, query, {
    limit: Math.max(24, limit * 4),
    graphDepth: options.graphDepth ?? 1,
    boostSource: task.ref,
    boostTag: task.tags,
  });
  const pinnedCharacters = pinned.reduce((total, item) => total + item.body.length, 0);
  let remaining = Math.max(0, characterBudget - pinnedCharacters);
  const selected: MemorySearchResult[] = [];
  const selectedIds = new Set<string>();
  const selectedKinds = new Set<MemoryKind>();
  const consider = (memory: MemorySearchResult, requireNewKind: boolean): void => {
    if (selected.length >= limit || selectedIds.has(memory.id)) return;
    if (requireNewKind && selectedKinds.has(memory.kind)) return;
    const cost = memory.title.length + memory.body.length + memory.explanation.length + 32;
    if (cost > remaining) return;
    selected.push(memory);
    selectedIds.add(memory.id);
    selectedKinds.add(memory.kind);
    remaining -= cost;
  };
  for (const memory of candidates) consider(memory, true);
  for (const memory of candidates) consider(memory, false);
  return { pinned, matches: selected };
}

function isStaleRetrieval(document: MemoryDocument, now = Date.now()): boolean {
  if (document.status !== 'active') return true;
  return Boolean(document.review_after && new Date(document.review_after).getTime() <= now);
}

/** Evaluate golden retrieval cases without changing canonical memories. */
export async function evaluateMemoryRetrieval(
  db: Db,
  root: string,
  project: Project | null,
  golden: RetrievalGoldenCase[],
  options: { k?: number } = {},
): Promise<RetrievalEvaluation> {
  const k = Math.max(1, Math.floor(options.k ?? 3));
  const cases: RetrievalEvaluationCase[] = [];
  for (const [index, testCase] of golden.entries()) {
    if (!testCase.relevant.length) {
      throw new Error(`Retrieval golden case ${index + 1} needs at least one relevant memory id.`);
    }
    const searchOptions = { ...testCase.options, limit: k };
    const results = searchOptions.semantic
      ? await searchMemories(db, root, project, testCase.query, {
          ...searchOptions,
          semantic: true,
        })
      : searchMemories(db, root, project, testCase.query, {
          ...searchOptions,
          semantic: false,
        });
    const relevant = new Set(testCase.relevant.map((identifier) => {
      try { return memoryByIdentifier(db, root, project, identifier).id; }
      catch { return identifier; }
    }));
    const retrieved = results.slice(0, k);
    const relevantHits = retrieved.filter((memory) => relevant.has(memory.id));
    const firstRelevant = retrieved.findIndex((memory) => relevant.has(memory.id));
    cases.push({
      name: testCase.name ?? `case-${index + 1}`,
      retrieved: retrieved.map((memory) => memory.id),
      recall_at_k: relevantHits.length / relevant.size,
      reciprocal_rank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      stale_hits: retrieved.filter((memory) => isStaleRetrieval(memory)).length,
      context_precision: retrieved.length ? relevantHits.length / retrieved.length : 0,
    });
  }
  const totalRetrieved = cases.reduce((total, item) => total + item.retrieved.length, 0);
  const totalStale = cases.reduce((total, item) => total + item.stale_hits, 0);
  const average = (field: 'recall_at_k' | 'reciprocal_rank' | 'context_precision'): number =>
    cases.length ? cases.reduce((total, item) => total + item[field], 0) / cases.length : 0;
  return {
    k,
    recall_at_k: average('recall_at_k'),
    mrr: average('reciprocal_rank'),
    stale_hit_rate: totalRetrieved ? totalStale / totalRetrieved : 0,
    context_precision: average('context_precision'),
    cases,
  };
}

type MigrationEntry = {
  relative: string;
  absolute: string;
  kind: 'directory' | 'file' | 'symlink';
};

type MigrationRootInspection = {
  root: string;
  exists: boolean;
  entries: MigrationEntry[];
  documents: MemoryDocument[];
  renderedByPath: Map<string, string>;
  conflicts: MemoryMigrationConflict[];
  unresolved: Array<{ memory_id: string; target: string }>;
  canonicalizedRelations: number;
  needsNormalization: boolean;
};

function migrationRelative(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function migrationEntries(root: string): MigrationEntry[] {
  if (!existsSync(root)) return [];
  const entries: MigrationEntry[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const item: MigrationEntry = {
        relative: migrationRelative(root, absolute),
        absolute,
        kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
      };
      entries.push(item);
      if (item.kind === 'directory') visit(absolute);
    }
  };
  visit(root);
  return entries.sort((a, b) => a.relative.localeCompare(b.relative));
}

function isGitMigrationPath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/');
}

function comparableIndex(raw: string): string {
  return raw.replace(indexBlockPattern(), '<!-- memory:index -->').trim();
}

function migrationEntryContent(entry: MigrationEntry): string {
  if (entry.kind === 'symlink') return `symlink:${readlinkSync(entry.absolute)}`;
  if (entry.kind === 'directory') return 'directory';
  const raw = readFileSync(entry.absolute);
  if (basename(entry.absolute) === 'MEMORY.md') {
    return `index:${comparableIndex(raw.toString('utf8'))}`;
  }
  return `file:${createHash('sha256').update(raw).digest('hex')}`;
}

/** Content fingerprint used to detect concurrent writes during migration. */
export function memoryStoreFingerprint(root: string): string | null {
  const absolute = resolve(root);
  if (!existsSync(absolute)) return null;
  const digest = createHash('sha256');
  for (const entry of migrationEntries(absolute)) {
    digest.update(entry.relative);
    digest.update('\0');
    digest.update(entry.kind);
    digest.update('\0');
    if (entry.kind !== 'directory') digest.update(migrationEntryContent(entry));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function projectForMigrationPath(
  db: Db,
  root: string,
  path: string,
): Project | null | undefined {
  const parts = migrationRelative(root, path).split('/');
  if (parts[0] === 'global' && parts.length > 1) return null;
  if (parts[0] !== 'projects' || parts.length < 3) return undefined;
  return listProjects(db, true).find((project) => project.key === parts[1]);
}

function canonicalMigrationRelations(
  documents: MemoryDocument[],
  allowUnresolved: boolean,
): {
  documents: MemoryDocument[];
  conflicts: MemoryMigrationConflict[];
  unresolved: Array<{ memory_id: string; target: string }>;
  canonicalized: number;
} {
  const conflicts: MemoryMigrationConflict[] = [];
  const unresolved: Array<{ memory_id: string; target: string }> = [];
  let canonicalized = 0;
  const normalized = documents.map((document) => ({
    ...document,
    aliases: uniqueStrings([document.id, ...document.aliases]),
    relations: document.relations.map((relation) => ({ ...relation })),
  }));

  for (const document of normalized) {
    document.relations = document.relations.map((relation) => {
      try {
        assertRelationShape(relation);
      } catch (error) {
        conflicts.push({
          code: 'relation_target',
          path: document.path,
          message: (error as Error).message,
        });
        return relation;
      }
      if (relation.target_type !== 'memory') return relation;
      const visible = normalized.filter((candidate) =>
        candidate.scope === 'global' || (
          document.scope === 'project' &&
          candidate.scope === 'project' &&
          candidate.project_key === document.project_key
        ));
      const exact = visible.filter((candidate) =>
        candidate.id === relation.target || candidate.aliases.includes(relation.target));
      const matches = exact.length
        ? exact
        : visible.filter((candidate) => candidate.id.startsWith(relation.target));
      if (matches.length !== 1) {
        const detail = matches.length
          ? `is ambiguous (${matches.map((candidate) => candidate.id).join(', ')})`
          : 'does not resolve';
        if (allowUnresolved && matches.length === 0) {
          unresolved.push({ memory_id: document.id, target: relation.target });
          return relation;
        }
        conflicts.push({
          code: 'relation_target',
          path: document.path,
          message: `Memory relation target "${relation.target}" ${detail}.`,
        });
        return relation;
      }
      const target = matches[0];
      if (target.id === document.id) {
        conflicts.push({
          code: 'relation_target',
          path: document.path,
          message: `Memory ${document.id} cannot link to itself.`,
        });
        return relation;
      }
      if (relation.type === 'supersedes' && (
        target.scope !== document.scope || target.project_key !== document.project_key
      )) {
        conflicts.push({
          code: 'relation_target',
          path: document.path,
          message: `Supersedes target ${target.id} is not in the same memory scope.`,
        });
        return relation;
      }
      if (target.id !== relation.target) canonicalized += 1;
      return { ...relation, target: target.id };
    });
    document.relations = uniqueRelations(document.relations);
    document.supersedes = document.relations.find(
      (relation) => relation.type === 'supersedes' && relation.target_type === 'memory',
    )?.target ?? null;
  }

  // Older stores represented replacement as a scalar link and commonly
  // archived the old note. Current semantics make replacement explicit: the
  // replacement is active and its target is superseded. Upgrade both halves
  // together so a successful migration also passes the normal memory lint.
  const byId = new Map(normalized.map((document) => [document.id, document]));
  for (const document of normalized) {
    for (const relation of document.relations) {
      if (relation.type !== 'supersedes' || relation.target_type !== 'memory') continue;
      const target = byId.get(relation.target);
      if (!target) continue;
      document.status = 'active';
      target.status = 'superseded';
    }
  }
  return { documents: normalized, conflicts, unresolved, canonicalized };
}

function inspectMigrationRoot(
  db: Db,
  root: string,
  allowUnresolved: boolean,
): MigrationRootInspection {
  const absoluteRoot = resolve(root);
  const entries = migrationEntries(absoluteRoot);
  if (!existsSync(absoluteRoot)) {
    return {
      root: absoluteRoot,
      exists: false,
      entries,
      documents: [],
      renderedByPath: new Map(),
      conflicts: [],
      unresolved: [],
      canonicalizedRelations: 0,
      needsNormalization: false,
    };
  }

  const conflicts: MemoryMigrationConflict[] = [];
  const projects = listProjects(db, true);
  const projectsByKey = new Map(projects.map((project) => [project.key, project]));
  const projectsDir = join(absoluteRoot, 'projects');
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        conflicts.push({
          code: 'invalid_layout',
          path: join(projectsDir, entry.name),
          message: `Memory projects entry "${entry.name}" is not a directory.`,
        });
      } else if (!projectsByKey.has(entry.name)) {
        conflicts.push({
          code: 'invalid_layout',
          path: join(projectsDir, entry.name),
          message: `Memory project directory "${entry.name}" has no matching project in the database.`,
        });
      }
    }
  }

  const topicEntries = entries.filter((entry) =>
    !isGitMigrationPath(entry.relative) &&
    entry.relative.endsWith('.md') &&
    basename(entry.relative) !== 'MEMORY.md');
  const documents: MemoryDocument[] = [];
  for (const entry of topicEntries) {
    if (entry.kind !== 'file') {
      conflicts.push({
        code: 'invalid_layout',
        path: entry.absolute,
        message: 'A memory topic must be a regular Markdown file.',
      });
      continue;
    }
    const project = projectForMigrationPath(db, absoluteRoot, entry.absolute);
    if (project === undefined) {
      conflicts.push({
        code: 'invalid_layout',
        path: entry.absolute,
        message: 'Markdown topic is outside global/ or a known projects/<key>/ scope.',
      });
      continue;
    }
    try {
      documents.push(parseMemoryFile(entry.absolute, project));
    } catch (error) {
      conflicts.push({
        code: 'invalid_memory',
        path: entry.absolute,
        message: (error as Error).message,
      });
    }
  }

  const pathsById = new Map<string, string[]>();
  for (const document of documents) {
    pathsById.set(document.id, [...(pathsById.get(document.id) ?? []), document.path]);
  }
  for (const [id, paths] of pathsById) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      conflicts.push({
        code: 'duplicate_id',
        path,
        message: `Memory id ${id} appears in multiple files: ${paths.join(', ')}.`,
      });
    }
  }

  const relations = canonicalMigrationRelations(documents, allowUnresolved);
  conflicts.push(...relations.conflicts);
  const renderedByPath = new Map<string, string>();
  let needsNormalization = entries.some((entry) =>
    entry.kind === 'file' && basename(entry.relative) === 'MEMORY.md' &&
    readFileSync(entry.absolute, 'utf8').includes(LEGACY_INDEX_BEGIN));
  for (const document of relations.documents) {
    const rendered = renderMemory(document);
    renderedByPath.set(migrationRelative(absoluteRoot, document.path), rendered);
    if (readFileSync(document.path, 'utf8') !== rendered) needsNormalization = true;
  }
  return {
    root: absoluteRoot,
    exists: true,
    entries,
    documents: relations.documents,
    renderedByPath,
    conflicts,
    unresolved: relations.unresolved,
    canonicalizedRelations: relations.canonicalized,
    needsNormalization,
  };
}

function assertMigrationPaths(source: string, destination: string): void {
  const from = resolve(source);
  const to = resolve(destination);
  if (from === to) throw new Error('Memory migration source and destination must be different.');
  if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
    throw new Error('Memory migration roots cannot be nested inside one another.');
  }
}

function compareMigrationRoots(
  source: MigrationRootInspection,
  destination: MigrationRootInspection,
): {
  sourceOnly: string[];
  destinationOnly: string[];
  conflicts: MemoryMigrationConflict[];
} {
  const conflicts = [...source.conflicts, ...destination.conflicts];
  const usable = (entry: MigrationEntry): boolean => !isGitMigrationPath(entry.relative);
  const from = new Map(source.entries.filter(usable).map((entry) => [entry.relative, entry]));
  const to = new Map(destination.entries.filter(usable).map((entry) => [entry.relative, entry]));
  const sourceOnly = [...from.entries()]
    .filter(([path, entry]) => entry.kind !== 'directory' && !to.has(path))
    .map(([path]) => path);
  const destinationOnly = [...to.entries()]
    .filter(([path, entry]) => entry.kind !== 'directory' && !from.has(path))
    .map(([path]) => path);
  for (const [path, sourceEntry] of from) {
    const destinationEntry = to.get(path);
    if (!destinationEntry) continue;
    const sourceRendered = source.renderedByPath.get(path);
    const destinationRendered = destination.renderedByPath.get(path);
    const same = sourceEntry.kind === destinationEntry.kind && (
      sourceRendered !== undefined && destinationRendered !== undefined
        ? sourceRendered === destinationRendered
        : migrationEntryContent(sourceEntry) === migrationEntryContent(destinationEntry)
    );
    if (!same) {
      conflicts.push({
        code: 'path_conflict',
        path,
        message: `Source and destination contain different content at ${path}.`,
      });
    }
  }

  const destinationIds = new Map(destination.documents.map((document) => [document.id, document]));
  for (const document of source.documents) {
    const other = destinationIds.get(document.id);
    if (!other) continue;
    const sourcePath = migrationRelative(source.root, document.path);
    const destinationPath = migrationRelative(destination.root, other.path);
    if (sourcePath !== destinationPath) {
      conflicts.push({
        code: 'duplicate_id',
        path: sourcePath,
        message: `Memory id ${document.id} exists at both ${sourcePath} and ${destinationPath}.`,
      });
    }
  }
  return { sourceOnly, destinationOnly, conflicts };
}

/** Inventory a legacy/current pair without changing either store. */
export function inspectMemoryMigration(
  db: Db,
  options: MemoryMigrationOptions = {},
): MemoryMigrationInventory {
  const sourcePath = resolve(options.source ?? legacyMemoryRoot());
  const destinationPath = resolve(options.destination ?? currentMemoryRoot());
  assertMigrationPaths(sourcePath, destinationPath);
  const source = inspectMigrationRoot(db, sourcePath, Boolean(options.allowUnresolvedMemoryTargets));
  const destination = inspectMigrationRoot(
    db,
    destinationPath,
    Boolean(options.allowUnresolvedMemoryTargets),
  );
  const compared = compareMigrationRoots(source, destination);
  let state: MemoryMigrationState;
  if (compared.conflicts.length) state = 'conflict';
  else if (!source.exists && !destination.exists) state = 'missing';
  else if (source.exists && !destination.exists) state = 'legacy_only';
  else if (!source.exists) state = 'current_only';
  else if (compared.sourceOnly.length) state = 'mergeable';
  else state = 'synchronized';
  const countFiles = (inspection: MigrationRootInspection): number =>
    inspection.entries.filter((entry) => entry.kind !== 'directory').length;
  return {
    source: sourcePath,
    destination: destinationPath,
    state,
    source_exists: source.exists,
    destination_exists: destination.exists,
    source_files: countFiles(source),
    destination_files: countFiles(destination),
    source_memories: source.documents.length,
    destination_memories: destination.documents.length,
    source_has_git: existsSync(join(sourcePath, '.git')),
    destination_has_git: existsSync(join(destinationPath, '.git')),
    source_only_files: compared.sourceOnly,
    destination_only_files: compared.destinationOnly,
    conflicts: compared.conflicts,
  };
}

function cloneRoot(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function copyMissingMigrationEntries(source: string, destination: string): void {
  const visit = (from: string, relativePath = ''): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (!relativePath && entry.name === '.git') continue;
      const nextRelative = relativePath ? join(relativePath, entry.name) : entry.name;
      const sourcePath = join(from, entry.name);
      const destinationPath = join(destination, nextRelative);
      if (existsSync(destinationPath)) {
        const destinationEntry = lstatSync(destinationPath);
        const sourceKind = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
        const destinationKind = destinationEntry.isDirectory()
          ? 'directory'
          : destinationEntry.isSymbolicLink() ? 'symlink' : 'file';
        if (sourceKind !== destinationKind) {
          throw new Error(
            `Memory migration path collision at ${nextRelative}: source is ${sourceKind}, ` +
            `destination is ${destinationKind}.`,
          );
        }
        if (sourceKind === 'directory') {
          visit(sourcePath, nextRelative);
        }
        continue;
      }
      cpSync(sourcePath, destinationPath, {
        recursive: entry.isDirectory(),
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
  };
  visit(source);
}

function seedMigrationProjects(source: Db, destination: Db): Project[] {
  const projects = listProjects(source, true);
  const insert = destination.prepare(
    `INSERT INTO projects (id, key, name, color, archived_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const project of projects) {
    insert.run(
      project.id,
      project.key,
      project.name,
      project.color,
      project.archived_at,
      project.created_at,
    );
  }
  return projects;
}

function seedMigrationLintReferences(source: Db, destination: Db): Project[] {
  const projects = seedMigrationProjects(source, destination);
  const insertTask = destination.prepare(
    `INSERT INTO tasks (id, ref, project_id, seq, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tasks = source.prepare(
    'SELECT id, ref, project_id, seq, title, created_at, updated_at FROM tasks ORDER BY id',
  ).all() as unknown as Array<Record<string, unknown>>;
  for (const task of tasks) {
    insertTask.run(
      task.id as number,
      String(task.ref),
      task.project_id as number,
      task.seq as number,
      String(task.title),
      String(task.created_at),
      String(task.updated_at),
    );
  }
  const insertComment = destination.prepare(
    `INSERT INTO comments (id, task_id, author, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const comments = source.prepare(
    'SELECT id, task_id, author, kind, body, created_at FROM comments ORDER BY id',
  ).all() as unknown as Array<Record<string, unknown>>;
  for (const comment of comments) {
    insertComment.run(
      comment.id as number,
      comment.task_id as number,
      String(comment.author),
      String(comment.kind),
      String(comment.body),
      String(comment.created_at),
    );
  }
  return projects;
}

function reindexMigrationRoot(db: Db, root: string, refreshIndexes: boolean): number {
  let count = 0;
  const projects = listProjects(db, true);
  const global = syncMemoryScope(db, root, null);
  count += global.length;
  if (refreshIndexes && existsSync(memoryScopePath(root, null))) refreshMemoryIndex(root, null);
  for (const project of projects) {
    const memories = syncMemoryScope(db, root, project);
    count += memories.length;
    if (refreshIndexes && existsSync(memoryScopePath(root, project))) {
      refreshMemoryIndex(root, project);
    }
  }
  return count;
}

function normalizeMigrationStage(
  db: Db,
  stage: string,
  allowUnresolved: boolean,
): {
  memories: number;
  rewritten: number;
  canonicalized: number;
  unresolved: Array<{ memory_id: string; target: string }>;
} {
  const inspection = inspectMigrationRoot(db, stage, allowUnresolved);
  if (inspection.conflicts.length) {
    throw new Error(inspection.conflicts.map((conflict) => conflict.message).join('\n'));
  }
  let rewritten = 0;
  for (const document of inspection.documents) {
    const rendered = renderMemory(document);
    if (readFileSync(document.path, 'utf8') === rendered) continue;
    atomicWrite(document.path, rendered);
    rewritten += 1;
  }

  const scratch = openDb(':memory:');
  try {
    const projects = seedMigrationLintReferences(db, scratch);
    const memories = reindexMigrationRoot(scratch, stage, true);
    const verified = inspectMigrationRoot(scratch, stage, allowUnresolved);
    if (verified.conflicts.length) {
      throw new Error(verified.conflicts.map((conflict) => conflict.message).join('\n'));
    }
    if (memories !== verified.documents.length) {
      throw new Error(
        `Migration indexed ${memories} memories but found ${verified.documents.length} topic files.`,
      );
    }
    const allowedUnresolved = new Set(verified.unresolved.map(
      (relation) => `${relation.memory_id}\0${relation.target}`,
    ));
    const lintIssues = new Map<string, MemoryLintIssue>();
    for (const scope of [null, ...projects] as Array<Project | null>) {
      for (const issue of lintMemories(scratch, stage, scope)) {
        if (
          allowUnresolved && issue.code === 'missing_target' &&
          issue.relation?.target_type === 'memory' &&
          allowedUnresolved.has(`${issue.memory_id}\0${issue.relation.target}`)
        ) continue;
        const key = JSON.stringify([
          issue.code,
          issue.memory_id,
          issue.relation?.type,
          issue.relation?.target_type,
          issue.relation?.target,
        ]);
        lintIssues.set(key, issue);
      }
    }
    if (lintIssues.size) {
      throw new Error(
        'Staged memory lint failed:\n' + [...lintIssues.values()]
          .map((issue) => `- ${issue.memory_id} [${issue.code}]: ${issue.message}`)
          .join('\n'),
      );
    }
    return {
      memories,
      rewritten,
      canonicalized: inspection.canonicalizedRelations,
      unresolved: inspection.unresolved,
    };
  } finally {
    scratch.close();
  }
}

function migrationFailure(inventory: MemoryMigrationInventory): Error {
  return new Error(
    `Memory migration found ${inventory.conflicts.length} unsafe conflict(s):\n` +
    inventory.conflicts.map((conflict) => `- ${conflict.path}: ${conflict.message}`).join('\n'),
  );
}

/**
 * Copy legacy memory into the current root through a validated sibling stage.
 * The legacy source is never changed or removed. Existing current memory is
 * atomically moved to a retained backup before activation.
 */
export function migrateMemoryStore(
  db: Db,
  options: MemoryMigrationOptions = {},
): MemoryMigrationReport {
  const inventory = inspectMemoryMigration(db, options);
  if (inventory.conflicts.length) throw migrationFailure(inventory);
  const allowUnresolved = Boolean(options.allowUnresolvedMemoryTargets);
  const sourceInspection = inspectMigrationRoot(db, inventory.source, allowUnresolved);
  const destinationInspection = inspectMigrationRoot(db, inventory.destination, allowUnresolved);
  const sourceFingerprint = memoryStoreFingerprint(inventory.source);
  const destinationFingerprint = memoryStoreFingerprint(inventory.destination);
  const needsDestinationRewrite = destinationInspection.needsNormalization;
  const shouldMigrate = inventory.state === 'legacy_only' || inventory.state === 'mergeable' ||
    ((inventory.state === 'current_only' || inventory.state === 'synchronized') && needsDestinationRewrite);

  if (!shouldMigrate) {
    const memories = inventory.destination_exists
      ? reindexMigrationRoot(db, inventory.destination, false)
      : 0;
    return {
      ...inventory,
      migrated: false,
      source_preserved: true,
      backup: null,
      memories,
      copied_files: 0,
      rewritten_memories: 0,
      canonicalized_relations: 0,
      unresolved_relations: destinationInspection.unresolved,
    };
  }

  mkdirSync(dirname(inventory.destination), { recursive: true });
  const stage = `${inventory.destination}.migration-${randomUUID()}.tmp`;
  const backup = inventory.destination_exists
    ? `${inventory.destination}.backup-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    : null;
  let destinationMoved = false;
  let stageActivated = false;
  try {
    if (inventory.destination_exists) {
      cloneRoot(inventory.destination, stage);
      if (inventory.source_exists) copyMissingMigrationEntries(inventory.source, stage);
    } else {
      cloneRoot(inventory.source, stage);
    }
    const normalized = normalizeMigrationStage(db, stage, allowUnresolved);
    if (!commitMemory(stage, 'memory: migrate legacy store and upgrade format')) {
      throw new Error('Could not commit the migrated memory format to its private Git history.');
    }
    if (memoryStoreFingerprint(inventory.source) !== sourceFingerprint) {
      throw new Error(
        `Memory migration source changed while it was being copied: ${inventory.source}. ` +
        'No destination was activated; run the migration again.',
      );
    }
    if (memoryStoreFingerprint(inventory.destination) !== destinationFingerprint) {
      throw new Error(
        `Memory migration destination changed while it was being prepared: ${inventory.destination}. ` +
        'No destination was activated; run the migration again.',
      );
    }
    if (backup) {
      renameSync(inventory.destination, backup);
      destinationMoved = true;
    }
    renameSync(stage, inventory.destination);
    stageActivated = true;
    reindexMigrationRoot(db, inventory.destination, false);
    return {
      ...inventory,
      migrated: true,
      source_preserved: true,
      backup,
      memories: normalized.memories,
      copied_files: inventory.state === 'legacy_only'
        ? sourceInspection.entries.filter((entry) => entry.kind !== 'directory').length
        : inventory.source_only_files.length,
      rewritten_memories: normalized.rewritten,
      canonicalized_relations: normalized.canonicalized,
      unresolved_relations: normalized.unresolved,
    };
  } catch (error) {
    try {
      if (stageActivated && existsSync(inventory.destination)) {
        renameSync(inventory.destination, stage);
        stageActivated = false;
      }
      if (destinationMoved && backup && existsSync(backup)) {
        renameSync(backup, inventory.destination);
        destinationMoved = false;
      }
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      const restored = existsSync(inventory.destination)
        ? inventory.destination
        : existsSync(inventory.source) ? inventory.source : null;
      if (restored) reindexMigrationRoot(db, restored, false);
    } catch {
      // Preserve the original migration failure; source and backup are never deleted.
    }
    throw error;
  }
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
    '-c', 'user.name=orchestration',
    '-c', 'user.email=orchestration@local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ]).status === 0;
}
