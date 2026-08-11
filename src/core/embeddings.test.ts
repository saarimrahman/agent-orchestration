import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CommandEmbeddingProvider,
  configuredEmbeddingProvider,
  cosineSimilarity,
  reciprocalRankFusion,
  reciprocalRankScore,
} from './embeddings.ts';

function nodeProvider(script: string, ...args: string[]): CommandEmbeddingProvider {
  return new CommandEmbeddingProvider([process.execPath, '-e', script, ...args]);
}

const READ_INPUT = `
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const { texts } = JSON.parse(input);
    process.stdout.write(JSON.stringify({ vectors: texts.map(text => [text.length, 1]) }));
  });
`;

describe('embedding provider configuration', () => {
  test('is disabled unless a command is explicitly configured', () => {
    assert.equal(configuredEmbeddingProvider({}), null);
  });

  test('parses a JSON argv array and prefers the current setting', async () => {
    const current = JSON.stringify([process.execPath, '-e', READ_INPUT]);
    const provider = configuredEmbeddingProvider({
      ORCHESTRATION_EMBEDDING_COMMAND: current,
      ORCH_EMBEDDING_COMMAND: 'not valid json',
    });

    assert.ok(provider);
    assert.deepEqual(await provider.embed(['hi', 'hello']), [
      [2, 1],
      [5, 1],
    ]);
  });

  test('supports the legacy setting', async () => {
    const provider = configuredEmbeddingProvider({
      ORCH_EMBEDDING_COMMAND: JSON.stringify([process.execPath, '-e', READ_INPUT]),
    });
    assert.ok(provider);
    assert.deepEqual(await provider.embed(['legacy']), [[6, 1]]);
  });

  test('reports malformed configuration with the setting name and example', () => {
    assert.throws(
      () => configuredEmbeddingProvider({ ORCHESTRATION_EMBEDDING_COMMAND: 'python embed.py' }),
      /ORCHESTRATION_EMBEDDING_COMMAND is not valid JSON.*argv array/s,
    );
    assert.throws(
      () => configuredEmbeddingProvider({ ORCHESTRATION_EMBEDDING_COMMAND: '[]' }),
      /non-empty JSON argv array/,
    );
    assert.throws(
      () => configuredEmbeddingProvider({ ORCHESTRATION_EMBEDDING_COMMAND: '["python",2]' }),
      /only strings/,
    );
  });
});

describe('command embedding provider', () => {
  test('uses a configuration-specific cache identity', () => {
    const first = new CommandEmbeddingProvider(['embed', '--model', 'first']);
    const same = new CommandEmbeddingProvider(['embed', '--model', 'first']);
    const second = new CommandEmbeddingProvider(['embed', '--model', 'second']);

    assert.equal(first.kind, same.kind);
    assert.notEqual(first.kind, second.kind);
  });

  test('accepts a matrix response and does not invoke a shell', async () => {
    const script = `
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write(JSON.stringify([[process.argv[1].length]])));
    `;
    const provider = nodeProvider(script, '$HOME; echo unsafe');
    assert.deepEqual(await provider.embed(['one']), [[18]]);
  });

  test('does not launch the command for an empty batch', async () => {
    const provider = nodeProvider('process.exit(17)');
    assert.deepEqual(await provider.embed([]), []);
  });

  test('validates vector count, dimensions, and finite components', async () => {
    await assert.rejects(
      nodeProvider(`process.stdin.resume(); process.stdin.on('end', () => console.log('[[1]]'))`).embed([
        'one',
        'two',
      ]),
      /returned 1 vector\(s\) for 2 input text\(s\)/,
    );
    await assert.rejects(
      nodeProvider(`process.stdin.resume(); process.stdin.on('end', () => console.log('[[1],[1,2]]'))`).embed([
        'one',
        'two',
      ]),
      /dimension 2; expected 1/,
    );
    await assert.rejects(
      nodeProvider(`process.stdin.resume(); process.stdin.on('end', () => console.log('[[1,null]]'))`).embed([
        'one',
      ]),
      /component 1 must be a finite number/,
    );
  });

  test('reports invalid JSON and subprocess diagnostics', async () => {
    await assert.rejects(
      nodeProvider(`process.stdin.resume(); process.stdin.on('end', () => console.log('not json'))`).embed([
        'one',
      ]),
      /stdout was not valid JSON/,
    );
    await assert.rejects(
      nodeProvider(`process.stdin.resume(); process.stdin.on('end', () => { console.error('model missing'); process.exit(4); })`).embed([
        'one',
      ]),
      /exit code 4.*model missing/,
    );
  });

  test('reports an executable that cannot be started', async () => {
    const provider = new CommandEmbeddingProvider(['/definitely/not/an/executable']);
    await assert.rejects(provider.embed(['one']), /Could not start embedding executable/);
  });
});

describe('hybrid ranking helpers', () => {
  test('computes cosine similarity and handles a zero vector neutrally', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
    assert.throws(() => cosineSimilarity([1], [1, 2]), /equal dimensions/);
    assert.throws(() => cosineSimilarity([Number.NaN], [1]), /must be finite/);
  });

  test('fuses rankings, ignores duplicates within one list, and supports stable keys', () => {
    const fused = reciprocalRankFusion(
      [
        [{ id: 'a' }, { id: 'b' }, { id: 'b' }],
        [{ id: 'b' }, { id: 'c' }],
      ],
      { k: 0, key: (item) => item.id },
    );

    assert.deepEqual(
      fused.map(({ item }) => item.id),
      ['b', 'a', 'c'],
    );
    assert.equal(fused[0].score, 1.5);
    assert.equal(reciprocalRankScore(2, 0), 0.5);
    assert.throws(() => reciprocalRankScore(0), /positive integer/);
    assert.throws(() => reciprocalRankFusion([], { k: -1 }), /non-negative/);
  });
});
