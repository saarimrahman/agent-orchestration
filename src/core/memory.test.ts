import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { openDb, type Db } from './db.ts';
import type { EmbeddingProvider } from './embeddings.ts';
import { addComment } from './activity.ts';
import { createProject } from './projects.ts';
import { createTask } from './tasks.ts';
import {
  archiveMemory,
  currentMemoryRoot,
  deleteMemory,
  evaluateMemoryRetrieval,
  getMemory,
  inspectMemoryMigration,
  legacyMemoryRoot,
  linkMemory,
  lintMemories,
  listMemories,
  memoryBacklinks,
  memoryContextForTask,
  memoryGraph,
  memoryHistory,
  memoryStoreFingerprint,
  migrateMemoryStore,
  rememberMemory,
  searchMemories,
  syncMemoryScope,
  unlinkMemory,
  updateMemory,
} from './memory.ts';
import type { Project } from './types.ts';

let db: Db;
let project: Project;
let root: string;

function setFlatFrontmatter(path: string, key: string, value: unknown): void {
  const raw = readFileSync(path, 'utf8');
  const marker = '\n---\n\n# ';
  assert.ok(raw.includes(marker));
  writeFileSync(path, raw.replace(marker, `\n${key}: ${JSON.stringify(value)}${marker}`), 'utf8');
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'fixture-semantic-v1';
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (/car|automobile|vehicle|engine/.test(lower)) return [1, 0, 0];
      if (/database|sqlite|query/.test(lower)) return [0, 1, 0];
      return [0, 0, 1];
    });
  }
}

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

  test('preserves unknown flat frontmatter and resolves stable aliases', () => {
    const memory = rememberMemory(db, root, {
      project,
      title: 'Deploy safely',
      body: 'Use a canary before the full rollout.',
      aliases: ['canary-rule'],
      version: false,
    });
    setFlatFrontmatter(memory.path, 'cssclasses', ['wide-page']);
    syncMemoryScope(db, root, project);

    updateMemory(db, root, project, 'canary-rule', {
      tags: ['deployment'],
      version: false,
    });

    const updated = getMemory(db, root, project, memory.id);
    assert.deepEqual(updated.aliases, [memory.id, 'canary-rule']);
    assert.deepEqual(updated.extra_frontmatter, { cssclasses: ['wide-page'] });
    assert.match(readFileSync(memory.path, 'utf8'), /cssclasses: \["wide-page"\]/);
  });

  test('indexes typed relations and renders Obsidian-compatible related links', () => {
    const target = rememberMemory(db, root, {
      project,
      title: 'Release checklist',
      body: 'Check migrations before deploy.',
      version: false,
    });
    const source = rememberMemory(db, root, {
      project,
      title: 'Deployment rationale',
      body: 'The checklist prevents partial releases.',
      version: false,
    });

    const linked = linkMemory(db, root, project, source.id, {
      type: 'supports',
      target_type: 'memory',
      target: target.id.slice(0, 12),
    }, { version: false });

    assert.deepEqual(linked.relations, [{
      type: 'supports',
      target_type: 'memory',
      target: target.id,
    }]);
    assert.match(readFileSync(source.path, 'utf8'), new RegExp(`\\[\\[${target.id}\\]\\]`));
    const backlinks = memoryBacklinks(db, root, project, 'memory', target.id);
    assert.deepEqual(backlinks.map((item) => [item.source_id, item.type]), [[source.id, 'supports']]);

    const unlinked = unlinkMemory(db, root, project, source.id, linked.relations[0], { version: false });
    assert.deepEqual(unlinked.relations, []);
    assert.deepEqual(memoryBacklinks(db, root, project, 'memory', target.id), []);
  });

  test('validates task, comment, file, and URL targets', () => {
    const task = createTask(db, { title: 'Ship release', project: project.key, actor: 'test' });
    const comment = addComment(db, task.id, 'test', 'Remember the rollback switch.');
    const file = join(root, 'runbook.txt');
    writeFileSync(file, 'rollback', 'utf8');
    let memory = rememberMemory(db, root, {
      project,
      body: 'Release evidence is connected here.',
      version: false,
    });
    const relations = [
      { type: 'applies_to', target_type: 'task', target: task.ref },
      { type: 'derived_from', target_type: 'comment', target: String(comment.id) },
      { type: 'derived_from', target_type: 'file', target: file },
      { type: 'relates', target_type: 'url', target: 'https://example.com/runbook' },
    ] as const;
    for (const relation of relations) {
      memory = linkMemory(db, root, project, memory.id, relation, { version: false });
    }
    assert.equal(memory.relations.length, 4);
    assert.equal(memory.relations.at(-1)?.target, 'https://example.com/runbook');
    assert.throws(() => linkMemory(db, root, project, memory.id, {
      type: 'applies_to', target_type: 'task', target: 'demo-999',
    }, { version: false }), /No task/);
    assert.throws(() => linkMemory(db, root, project, memory.id, {
      type: 'relates', target_type: 'url', target: 'javascript:alert(1)',
    }, { version: false }), /http or https/);
  });

  test('superseding is a coordinated lifecycle update and legacy metadata remains readable', () => {
    const old = rememberMemory(db, root, {
      project,
      title: 'Old deployment rule',
      body: 'Deploy directly to every node.',
      version: false,
    });
    const replacement = rememberMemory(db, root, {
      project,
      title: 'New deployment rule',
      body: 'Deploy to a canary first.',
      status: 'candidate',
      supersedes: old.id,
      version: false,
    });

    assert.equal(replacement.status, 'active');
    assert.equal(getMemory(db, root, project, old.id).status, 'superseded');
    assert.equal(replacement.supersedes, old.id);
    assert.deepEqual(replacement.relations, [{
      type: 'supersedes', target_type: 'memory', target: old.id,
    }]);
    const raw = readFileSync(replacement.path, 'utf8');
    assert.match(raw, new RegExp(`supersedes: "${old.id}"`));
    assert.match(raw, /relations: \[/);
    assert.deepEqual(memoryBacklinks(db, root, project, 'memory', old.id).map((x) => x.source_id), [replacement.id]);

    // Files from the scalar-only format are upgraded in memory without requiring a rewrite.
    writeFileSync(
      replacement.path,
      raw.replace(/^relations: .*\n/m, '').replace(/^aliases: .*\n/m, ''),
      'utf8',
    );
    syncMemoryScope(db, root, project);
    const adapted = getMemory(db, root, project, replacement.id);
    assert.deepEqual(adapted.aliases, [replacement.id]);
    assert.deepEqual(adapted.relations, [{
      type: 'supersedes', target_type: 'memory', target: old.id,
    }]);

    unlinkMemory(db, root, project, replacement.id, replacement.relations[0], { version: false });
    assert.equal(getMemory(db, root, project, old.id).status, 'superseded');
  });

  test('rejects supersedes cycles without changing either canonical memory', () => {
    const first = rememberMemory(db, root, { project, body: 'First rule.', version: false });
    const second = rememberMemory(db, root, { project, body: 'Second rule.', version: false });
    linkMemory(db, root, project, first.id, {
      type: 'supersedes', target_type: 'memory', target: second.id,
    }, { version: false });
    const beforeFirst = readFileSync(first.path, 'utf8');
    const beforeSecond = readFileSync(second.path, 'utf8');

    assert.throws(() => linkMemory(db, root, project, second.id, {
      type: 'supersedes', target_type: 'memory', target: first.id,
    }, { version: false }), /create a cycle/);
    assert.equal(readFileSync(first.path, 'utf8'), beforeFirst);
    assert.equal(readFileSync(second.path, 'utf8'), beforeSecond);
  });

  test('keeps contradictory active memories visible and includes them in graph traversal', () => {
    const one = rememberMemory(db, root, {
      project,
      body: 'Falcon setting should be enabled.',
      version: false,
    });
    const two = rememberMemory(db, root, {
      project,
      body: 'Falcon setting should be disabled.',
      version: false,
    });
    linkMemory(db, root, project, one.id, {
      type: 'contradicts', target_type: 'memory', target: two.id,
    }, { version: false });

    assert.deepEqual(
      searchMemories(db, root, project, 'Falcon setting').map((memory) => memory.id).sort(),
      [one.id, two.id].sort(),
    );
    assert.equal(getMemory(db, root, project, one.id).status, 'active');
    assert.equal(getMemory(db, root, project, two.id).status, 'active');
    const graph = memoryGraph(db, root, project, two.id, { depth: 1 });
    assert.deepEqual(graph.memories.map((memory) => memory.id).sort(), [one.id, two.id].sort());
    assert.equal(graph.relations[0].type, 'contradicts');
  });

  test('lint reports dangling targets, duplicate aliases, and direct-edit cycles', () => {
    const first = rememberMemory(db, root, {
      project,
      body: 'First lint node.',
      aliases: ['shared-name'],
      version: false,
    });
    const second = rememberMemory(db, root, {
      project,
      body: 'Second lint node.',
      aliases: ['shared-name'],
      version: false,
    });
    setFlatFrontmatter(first.path, 'relations', [
      { type: 'supersedes', target_type: 'memory', target: second.id },
      { type: 'relates', target_type: 'memory', target: 'mem-missing' },
    ]);
    setFlatFrontmatter(second.path, 'relations', [
      { type: 'supersedes', target_type: 'memory', target: first.id },
    ]);
    syncMemoryScope(db, root, project);

    const issues = lintMemories(db, root, project);
    assert.ok(issues.some((issue) => issue.code === 'duplicate_alias'));
    assert.ok(issues.some((issue) => issue.code === 'missing_target'));
    assert.deepEqual(
      issues.filter((issue) => issue.code === 'supersedes_cycle').map((issue) => issue.memory_id).sort(),
      [first.id, second.id].sort(),
    );
  });

  test('stopword-only searches never leak candidates', () => {
    const active = rememberMemory(db, root, {
      project,
      body: 'Visible active memory.',
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'Hidden candidate memory.',
      status: 'candidate',
      version: false,
    });
    assert.deepEqual(
      searchMemories(db, root, project, 'the and task').map((memory) => memory.id),
      [active.id],
    );
  });

  test('fuses lexical strategies, applies structured filters, and explains ranking', () => {
    const verified = rememberMemory(db, root, {
      project,
      title: 'Production asset workflow',
      body: 'Compile production browser assets before assertions.',
      kind: 'fact',
      tags: ['deploy'],
      sources: ['demo-42'],
      lastVerifiedAt: new Date().toISOString(),
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'Production database maintenance.',
      kind: 'pitfall',
      tags: ['database'],
      version: false,
    });
    const candidate = rememberMemory(db, root, {
      project,
      body: 'Candidate production asset proposal.',
      kind: 'decision',
      status: 'candidate',
      version: false,
    });

    const prefix = searchMemories(db, root, project, 'product asset', {
      kind: 'fact',
      tag: 'DEPLOY',
      source: 'demo-42',
      verified: true,
    });
    assert.deepEqual(prefix.map((memory) => memory.id), [verified.id]);
    assert.match(prefix[0].explanation, /prefix lexical match|all terms lexical match/);
    assert.match(prefix[0].explanation, /verified memory/);
    assert.match(prefix[0].explanation, /exact tag match/);
    assert.ok(prefix[0].reasons.length >= 3);

    assert.deepEqual(
      searchMemories(db, root, project, 'the and task', { status: 'candidate' })
        .map((memory) => memory.id),
      [candidate.id],
    );
  });

  test('semantic retrieval finds paraphrases and caches document vectors', async () => {
    const provider = new FixtureEmbeddingProvider();
    const vehicle = rememberMemory(db, root, {
      project,
      body: 'If the car engine will not start, inspect the battery terminals.',
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'SQLite database queries use the local index.',
      version: false,
    });

    const first = await searchMemories(db, root, project, 'automobile breakdown', {
      semantic: true,
      embeddingProvider: provider,
    });
    assert.equal(first[0].id, vehicle.id);
    assert.match(first[0].explanation, /semantic similarity 1\.000/);
    assert.deepEqual(provider.calls.map((call) => call.length), [1, 2]);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as { n: number }).n,
      2,
    );

    await searchMemories(db, root, project, 'vehicle trouble', {
      semantic: true,
      embeddingProvider: provider,
    });
    assert.deepEqual(provider.calls.map((call) => call.length), [1, 2, 1]);

    updateMemory(db, root, project, vehicle.id, {
      body: 'If the car engine stalls, inspect the alternator.',
      version: false,
    });
    await searchMemories(db, root, project, 'vehicle trouble', {
      semantic: true,
      embeddingProvider: provider,
    });
    assert.deepEqual(provider.calls.map((call) => call.length), [1, 2, 1, 1, 1]);
  });

  test('semantic retrieval fails actionably when no provider is configured', async () => {
    const current = process.env.ORCHESTRATION_EMBEDDING_COMMAND;
    const legacy = process.env.ORCH_EMBEDDING_COMMAND;
    delete process.env.ORCHESTRATION_EMBEDDING_COMMAND;
    delete process.env.ORCH_EMBEDDING_COMMAND;
    try {
      await assert.rejects(
        searchMemories(db, root, project, 'paraphrase', { semantic: true }),
        /Semantic memory search needs an embedding provider.*ORCHESTRATION_EMBEDDING_COMMAND/,
      );
    } finally {
      if (current === undefined) delete process.env.ORCHESTRATION_EMBEDDING_COMMAND;
      else process.env.ORCHESTRATION_EMBEDDING_COMMAND = current;
      if (legacy === undefined) delete process.env.ORCH_EMBEDDING_COMMAND;
      else process.env.ORCH_EMBEDDING_COMMAND = legacy;
    }
  });

  test('expands bounded graph hops only from strong retrieval seeds', () => {
    const anchor = rememberMemory(db, root, {
      project,
      title: 'Deploy anchor procedure',
      body: 'Use the deploy anchor procedure.',
      version: false,
    });
    const neighbor = rememberMemory(db, root, {
      project,
      title: 'Neighbor checklist',
      body: 'A separately named checklist.',
      version: false,
    });
    const secondHop = rememberMemory(db, root, {
      project,
      title: 'Rollback detail',
      body: 'A separately named rollback detail.',
      version: false,
    });
    linkMemory(db, root, project, anchor.id, {
      type: 'relates', target_type: 'memory', target: neighbor.id,
    }, { version: false });
    linkMemory(db, root, project, neighbor.id, {
      type: 'supports', target_type: 'memory', target: secondHop.id,
    }, { version: false });

    const oneHop = searchMemories(db, root, project, 'deploy anchor', { graphDepth: 1 });
    assert.ok(oneHop.some((memory) => memory.id === neighbor.id));
    assert.ok(!oneHop.some((memory) => memory.id === secondHop.id));
    const twoHops = searchMemories(db, root, project, 'deploy anchor', { graphDepth: 2 });
    const expanded = twoHops.find((memory) => memory.id === secondHop.id);
    assert.ok(expanded);
    assert.match(expanded.explanation, /connected 2 graph hops/);
  });

  test('redirects stale lexical hits to their active replacement', () => {
    const old = rememberMemory(db, root, {
      project,
      title: 'Legacy quux protocol',
      body: 'Use the legacy quux handshake token.',
      version: false,
    });
    const replacement = rememberMemory(db, root, {
      project,
      title: 'Current protocol',
      body: 'Use the newly negotiated handshake.',
      supersedes: old.id,
      version: false,
    });

    const results = searchMemories(db, root, project, 'legacy quux token');
    assert.equal(results[0].id, replacement.id);
    assert.ok(!results.some((memory) => memory.id === old.id));
    assert.match(results[0].explanation, /active replacement for superseded memory/);
  });

  test('task context boosts direct provenance and diversifies within a character budget', () => {
    const task = createTask(db, {
      title: 'Fix browser asset deployment',
      project: project.key,
      tags: ['ui'],
      actor: 'test',
    });
    const direct = rememberMemory(db, root, {
      project,
      title: 'Task-specific decision',
      body: 'Prefer the reversible rollout.',
      kind: 'decision',
      sources: [task.ref],
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'Fix browser asset deployment with a production build.',
      kind: 'fact',
      tags: ['ui'],
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: 'Browser asset deployment can fail without a manifest.',
      kind: 'pitfall',
      tags: ['ui'],
      version: false,
    });
    rememberMemory(db, root, {
      project,
      body: `Browser asset deployment ${'x'.repeat(1_500)}`,
      kind: 'playbook',
      tags: ['ui'],
      version: false,
    });

    const context = memoryContextForTask(db, root, task, {
      limit: 4,
      characterBudget: 700,
      graphDepth: 0,
    });
    assert.equal(context.matches[0].id, direct.id);
    assert.match(context.matches[0].explanation, new RegExp(`exact source match: ${task.ref}`));
    assert.ok(new Set(context.matches.map((memory) => memory.kind)).size >= 3);
    assert.ok(context.matches.every((memory) => memory.body.length < 1_500));
  });

  test('evaluates golden retrieval with recall, MRR, stale rate, and context precision', async () => {
    const active = rememberMemory(db, root, {
      project,
      body: 'Quasar release checklist is authoritative.',
      version: false,
    });
    const stale = rememberMemory(db, root, {
      project,
      body: 'Obsolete nebula deployment note.',
      version: false,
    });
    archiveMemory(db, root, project, stale.id);

    const evaluation = await evaluateMemoryRetrieval(db, root, project, [
      { name: 'active', query: 'quasar checklist', relevant: [active.id] },
      { name: 'stale', query: 'obsolete nebula', relevant: [stale.id], options: { all: true } },
    ], { k: 1 });
    assert.equal(evaluation.recall_at_k, 1);
    assert.equal(evaluation.mrr, 1);
    assert.equal(evaluation.stale_hit_rate, 0.5);
    assert.equal(evaluation.context_precision, 1);
    assert.deepEqual(evaluation.cases.map((item) => item.retrieved.length), [1, 1]);
  });
});

describe('memory store migration', () => {
  test('exposes stable legacy and current home roots', () => {
    assert.equal(legacyMemoryRoot('/tmp/memory-home'), '/tmp/memory-home/.orch/memory');
    assert.equal(currentMemoryRoot('/tmp/memory-home'), '/tmp/memory-home/.orchestration/memory');
  });

  test('copies a legacy-only store, preserves history, and upgrades every topic', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    const target = rememberMemory(db, legacy, {
      project,
      title: 'Original rollout rule',
      body: 'Roll out directly to the fleet.',
    });
    const replacement = rememberMemory(db, legacy, {
      project,
      title: 'Replacement rollout rule',
      body: 'Use a canary rollout first.',
    });
    for (const memory of [target, replacement]) {
      writeFileSync(
        memory.path,
        readFileSync(memory.path, 'utf8').replace(/^aliases: .*\n/m, ''),
        'utf8',
      );
    }
    setFlatFrontmatter(replacement.path, 'supersedes', target.id.slice(0, 12));
    writeFileSync(join(legacy, 'private-note.txt'), 'preserve this file', 'utf8');
    const sourceBefore = readFileSync(replacement.path, 'utf8');
    const historyBefore = memoryHistory(legacy);

    const inventory = inspectMemoryMigration(db, { source: legacy, destination: current });
    assert.equal(inventory.state, 'legacy_only');
    assert.equal(inventory.source_memories, 2);
    const report = migrateMemoryStore(db, { source: legacy, destination: current });

    assert.equal(report.migrated, true);
    assert.equal(report.source_preserved, true);
    assert.equal(report.backup, null);
    assert.equal(report.memories, 2);
    assert.equal(report.rewritten_memories, 2);
    assert.equal(report.canonicalized_relations, 1);
    assert.equal(readFileSync(replacement.path, 'utf8'), sourceBefore);
    assert.equal(memoryHistory(legacy), historyBefore);
    assert.equal(readFileSync(join(current, 'private-note.txt'), 'utf8'), 'preserve this file');
    assert.ok(existsSync(join(current, '.git')));
    const migratedHistory = memoryHistory(current);
    assert.match(migratedHistory, /memory: migrate legacy store and upgrade format/);
    assert.ok(migratedHistory.includes(historyBefore.split(/\s/)[0]));

    const migrated = getMemory(db, current, project, replacement.id);
    const migratedTarget = getMemory(db, current, project, target.id);
    assert.deepEqual(migrated.aliases, [replacement.id]);
    assert.equal(migrated.status, 'active');
    assert.equal(migratedTarget.status, 'superseded');
    assert.equal(migrated.supersedes, target.id);
    assert.deepEqual(migrated.relations, [{
      type: 'supersedes',
      target_type: 'memory',
      target: target.id,
    }]);
    assert.match(readFileSync(migrated.path, 'utf8'), /^aliases: \[/m);
    assert.match(readFileSync(migrated.path, 'utf8'), /^relations: \[/m);
  });

  test('treats an already-current store as a verified no-op', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    rememberMemory(db, current, { project, body: 'Current memory remains visible.' });

    assert.equal(
      inspectMemoryMigration(db, { source: legacy, destination: current }).state,
      'current_only',
    );
    const report = migrateMemoryStore(db, { source: legacy, destination: current });
    assert.equal(report.migrated, false);
    assert.equal(report.backup, null);
    assert.equal(report.memories, 1);
    assert.equal(listMemories(db, current, project).length, 1);
  });

  test('refuses different content at the same relative path without changing either root', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    const memory = rememberMemory(db, legacy, {
      project,
      body: 'Legacy content must win only by an explicit decision.',
      version: false,
    });
    const relativePath = relative(legacy, memory.path);
    const destinationPath = join(current, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const destinationRaw = readFileSync(memory.path, 'utf8').replace('Legacy content', 'Current content');
    writeFileSync(destinationPath, destinationRaw, 'utf8');
    const sourceFingerprint = memoryStoreFingerprint(legacy);
    const destinationFingerprint = memoryStoreFingerprint(current);

    const inventory = inspectMemoryMigration(db, { source: legacy, destination: current });
    assert.equal(inventory.state, 'conflict');
    assert.ok(inventory.conflicts.some((conflict) => conflict.code === 'path_conflict'));
    assert.throws(
      () => migrateMemoryStore(db, { source: legacy, destination: current }),
      /unsafe conflict/,
    );
    assert.equal(memoryStoreFingerprint(legacy), sourceFingerprint);
    assert.equal(memoryStoreFingerprint(current), destinationFingerprint);
  });

  test('refuses file and directory shape collisions instead of silently dropping source data', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(current, 'collision'), { recursive: true });
    writeFileSync(join(legacy, 'collision'), 'legacy file must survive\n', 'utf8');
    writeFileSync(join(current, 'collision', 'current.txt'), 'current directory must survive\n', 'utf8');
    const sourceFingerprint = memoryStoreFingerprint(legacy);
    const destinationFingerprint = memoryStoreFingerprint(current);

    const inventory = inspectMemoryMigration(db, { source: legacy, destination: current });
    assert.equal(inventory.state, 'conflict');
    assert.ok(inventory.conflicts.some((conflict) =>
      conflict.code === 'path_conflict' && conflict.path === 'collision'));
    assert.throws(
      () => migrateMemoryStore(db, { source: legacy, destination: current }),
      /unsafe conflict/,
    );
    assert.equal(memoryStoreFingerprint(legacy), sourceFingerprint);
    assert.equal(memoryStoreFingerprint(current), destinationFingerprint);
  });

  test('merges non-overlapping stores through a retained destination backup', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    const legacyMemory = rememberMemory(db, legacy, {
      project,
      title: 'Legacy-only knowledge',
      body: 'This was learned before the directory rename.',
    });
    const currentMemory = rememberMemory(db, current, {
      project,
      title: 'Current-only knowledge',
      body: 'This was learned after the directory rename.',
    });

    const report = migrateMemoryStore(db, { source: legacy, destination: current });
    assert.equal(report.migrated, true);
    assert.ok(report.backup);
    assert.ok(existsSync(report.backup!));
    assert.ok(existsSync(legacyMemory.path));
    assert.equal(getMemory(db, current, project, legacyMemory.id).body,
      'This was learned before the directory rename.');
    assert.equal(getMemory(db, current, project, currentMemory.id).body,
      'This was learned after the directory rename.');
  });

  test('is idempotent after a successful legacy migration', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    rememberMemory(db, legacy, { project, body: 'Migrate this exactly once.' });

    const first = migrateMemoryStore(db, { source: legacy, destination: current });
    const fingerprint = memoryStoreFingerprint(current);
    const second = migrateMemoryStore(db, { source: legacy, destination: current });
    assert.equal(first.migrated, true);
    assert.equal(second.state, 'synchronized');
    assert.equal(second.migrated, false);
    assert.equal(second.backup, null);
    assert.equal(memoryStoreFingerprint(current), fingerprint);
  });

  test('leaves no partial destination when validation fails', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    const broken = join(legacy, 'global', 'notes', 'broken.md');
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, '# Missing frontmatter\n', 'utf8');

    assert.throws(
      () => migrateMemoryStore(db, { source: legacy, destination: current }),
      /unsafe conflict|needs YAML frontmatter/,
    );
    assert.equal(existsSync(current), false);
    assert.equal(readFileSync(broken, 'utf8'), '# Missing frontmatter\n');
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('.migration-')),
      [],
    );
  });

  test('rejects a staged supersession cycle before activating the destination', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    const first = rememberMemory(db, legacy, { project, body: 'First replacement.' });
    const second = rememberMemory(db, legacy, { project, body: 'Second replacement.' });
    const relation = (target: string) => [{
      type: 'supersedes',
      target_type: 'memory',
      target,
    }];
    setFlatFrontmatter(first.path, 'relations', relation(second.id));
    setFlatFrontmatter(second.path, 'relations', relation(first.id));
    const sourceFingerprint = memoryStoreFingerprint(legacy);

    assert.throws(
      () => migrateMemoryStore(db, { source: legacy, destination: current }),
      /Staged memory lint failed:[\s\S]*supersedes_cycle/,
    );
    assert.equal(existsSync(current), false);
    assert.equal(memoryStoreFingerprint(legacy), sourceFingerprint);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('.migration-')),
      [],
    );
  });

  test('rolls back a staged copy when private-history validation fails', () => {
    const legacy = join(root, 'legacy');
    const current = join(root, 'current');
    rememberMemory(db, legacy, {
      project,
      body: 'The staged migration must never become partially visible.',
      version: false,
    });
    writeFileSync(join(legacy, '.git'), 'not a valid git directory\n', 'utf8');
    const sourceFingerprint = memoryStoreFingerprint(legacy);

    assert.throws(
      () => migrateMemoryStore(db, { source: legacy, destination: current }),
      /Could not commit the migrated memory format/,
    );
    assert.equal(existsSync(current), false);
    assert.equal(memoryStoreFingerprint(legacy), sourceFingerprint);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('.migration-')),
      [],
    );
  });

  test('reports unknown projects and uncovered Markdown instead of silently skipping them', () => {
    const legacy = join(root, 'legacy');
    const unknown = join(legacy, 'projects', 'missing-project', 'notes', 'unknown.md');
    const misplaced = join(legacy, 'loose-topic.md');
    mkdirSync(dirname(unknown), { recursive: true });
    writeFileSync(unknown, '# Unknown project topic\n', 'utf8');
    writeFileSync(misplaced, '# Loose topic\n', 'utf8');

    const inventory = inspectMemoryMigration(db, {
      source: legacy,
      destination: join(root, 'current'),
    });
    assert.equal(inventory.state, 'conflict');
    assert.ok(inventory.conflicts.some((conflict) =>
      conflict.message.includes('no matching project')));
    assert.ok(inventory.conflicts.some((conflict) =>
      conflict.message.includes('outside global/')));
  });

  test('fingerprints all store content for the concurrent-write activation guard', () => {
    const legacy = join(root, 'legacy');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'one.txt'), 'one', 'utf8');
    const before = memoryStoreFingerprint(legacy);
    writeFileSync(join(legacy, 'two.txt'), 'two', 'utf8');
    assert.notEqual(memoryStoreFingerprint(legacy), before);
  });
});
