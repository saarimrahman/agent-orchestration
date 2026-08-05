import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Db } from './db.ts';
import { createProject } from './projects.ts';
import { createTask } from './tasks.ts';
import {
  archiveMemory,
  deleteMemory,
  getMemory,
  listMemories,
  memoryContextForTask,
  memoryHistory,
  rememberMemory,
  searchMemories,
  syncMemoryScope,
  updateMemory,
} from './memory.ts';
import type { Project } from './types.ts';

let db: Db;
let project: Project;
let root: string;

beforeEach(() => {
  db = openDb(':memory:');
  project = createProject(db, 'demo', 'Demo');
  root = mkdtempSync(join(tmpdir(), 'orchestration-memory-'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Markdown memory', () => {
  test('stores canonical files outside the source repository and indexes them', () => {
    const memory = rememberMemory(db, root, {
      project,
      title: 'UI test prerequisite',
      body: 'Build the production assets before running UI assertions.',
      kind: 'pitfall',
      tags: ['ui', 'testing'],
      sources: ['demo-1'],
      author: 'alice',
      version: false,
    });

    assert.ok(memory.path.startsWith(root));
    assert.ok(existsSync(memory.path));
    assert.ok(existsSync(join(root, 'projects', 'demo', 'MEMORY.md')));
    assert.match(readFileSync(memory.path, 'utf8'), /sources: \["demo-1"\]/);

    const results = searchMemories(db, root, project, 'production UI assets');
    assert.deepEqual(results.map((item) => item.id), [memory.id]);
    assert.match(results[0].snippet, /\[production\]|\[UI\]|\[assets\]/i);
  });

  test('keeps global and project scopes distinct', () => {
    const global = rememberMemory(db, root, {
      project: null,
      body: 'Prefer concise progress updates.',
      kind: 'preference',
      version: false,
    });
    const local = rememberMemory(db, root, {
      project,
      body: 'This project uses SQLite FTS5.',
      kind: 'fact',
      version: false,
    });

    assert.deepEqual(
      listMemories(db, root, project).map((item) => item.id).sort(),
      [global.id, local.id].sort(),
    );
    assert.deepEqual(listMemories(db, root, null).map((item) => item.id), [global.id]);
  });

  test('candidates stay out of retrieval until promoted', () => {
    const candidate = rememberMemory(db, root, {
      project,
      body: 'The release job may require a clean worktree.',
      status: 'candidate',
      version: false,
    });

    assert.deepEqual(searchMemories(db, root, project, 'release clean worktree'), []);
    assert.equal(listMemories(db, root, project)[0].status, 'candidate');

    updateMemory(db, root, project, candidate.id, { status: 'active', version: false });
    assert.deepEqual(
      searchMemories(db, root, project, 'release clean worktree').map((item) => item.id),
      [candidate.id],
    );
  });

  test('reindexes direct Markdown edits', () => {
    const memory = rememberMemory(db, root, {
      project,
      body: 'Use the blue deployment path.',
      version: false,
    });
    const edited = readFileSync(memory.path, 'utf8').replaceAll('blue deployment', 'green deployment');
    writeFileSync(memory.path, edited, 'utf8');

    syncMemoryScope(db, root, project);
    assert.deepEqual(searchMemories(db, root, project, 'green deployment').map((item) => item.id), [memory.id]);
    assert.deepEqual(searchMemories(db, root, project, 'blue'), []);
  });

  test('injects only active relevant memories into task context', () => {
    const relevant = rememberMemory(db, root, {
      project,
      title: 'UI asset workflow',
      body: 'Build UI assets before browser tests.',
      kind: 'playbook',
      tags: ['ui'],
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'Database backups happen on Friday.',
      kind: 'fact',
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'UI tests might use a remote browser.',
      status: 'candidate',
      version: false,
    });
    const task = createTask(db, {
      title: 'Fix UI browser assets',
      project: project.key,
      tags: ['ui'],
      actor: 'test',
    });

    const context = memoryContextForTask(db, root, task);
    assert.deepEqual(context.matches.map((item) => item.id), [relevant.id]);
  });

  test('archives instead of deleting and retains provenance', () => {
    const memory = rememberMemory(db, root, {
      project,
      body: 'Legacy parser requires Node 18.',
      sources: ['demo-7#comment-2'],
      version: false,
    });
    archiveMemory(db, root, project, memory.id);

    assert.deepEqual(searchMemories(db, root, project, 'legacy parser Node'), []);
    const archived = getMemory(db, root, project, memory.id);
    assert.equal(archived.status, 'archived');
    assert.deepEqual(archived.sources, ['demo-7#comment-2']);
  });

  test('deletes the canonical file and records the removal in private history', () => {
    const memory = rememberMemory(db, root, {
      project,
      title: 'Temporary workaround',
      body: 'Remove this after the migration.',
    });

    deleteMemory(db, root, project, memory.id);

    assert.equal(existsSync(memory.path), false);
    assert.throws(() => getMemory(db, root, project, memory.id), /No memory/);
    assert.doesNotMatch(readFileSync(join(root, 'projects', 'demo', 'MEMORY.md'), 'utf8'), /Temporary workaround/);
    assert.match(memoryHistory(root), new RegExp(`memory: delete ${memory.id}`));
  });

  test('creates private Git history without touching an enclosing repository', () => {
    const memory = rememberMemory(db, root, {
      project,
      body: 'Use WAL mode for concurrent readers.',
    });

    assert.ok(existsSync(join(root, '.git')));
    assert.match(memoryHistory(root, memory.path), /memory: add mem-/);
  });
});
