import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export type EmbeddingVector = number[];

export interface EmbeddingProvider {
  readonly kind: string;
  embed(texts: readonly string[]): Promise<EmbeddingVector[]>;
}

export type FusedRank<T> = {
  item: T;
  score: number;
};

export type ReciprocalRankFusionOptions<T> = {
  /** The usual RRF smoothing constant. */
  k?: number;
  /** Use a stable document id when lists contain different object instances. */
  key?: (item: T) => unknown;
};

const CURRENT_COMMAND = 'ORCHESTRATION_EMBEDDING_COMMAND';
const LEGACY_COMMAND = 'ORCH_EMBEDDING_COMMAND';

function validateArgv(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${source} must be a non-empty JSON argv array, for example ` +
        `'["python3","./embed.py"]'.`,
    );
  }
  if (!value.every((part) => typeof part === 'string')) {
    throw new Error(`${source} must contain only strings (the executable followed by its arguments).`);
  }
  if (value[0].trim().length === 0) {
    throw new Error(`${source} must name a non-empty executable as its first array item.`);
  }
  return [...value];
}

function parseConfiguredArgv(raw: string, source: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON. Set it to an argv array such as ` +
        `'["python3","./embed.py"]': ${(error as Error).message}`,
      { cause: error },
    );
  }
  return validateArgv(parsed, source);
}

function validateVectors(value: unknown, expectedCount: number): EmbeddingVector[] {
  if (!Array.isArray(value)) {
    throw new Error('Embedding command output must be a vector matrix or an object shaped as {"vectors":[...]}.');
  }
  if (value.length !== expectedCount) {
    throw new Error(
      `Embedding command returned ${value.length} vector(s) for ${expectedCount} input text(s).`,
    );
  }
  if (value.length === 0) return [];

  let dimension: number | null = null;
  return value.map((candidate, vectorIndex) => {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      throw new Error(`Embedding vector ${vectorIndex} must be a non-empty number array.`);
    }
    if (dimension === null) dimension = candidate.length;
    if (candidate.length !== dimension) {
      throw new Error(
        `Embedding vector ${vectorIndex} has dimension ${candidate.length}; expected ${dimension}.`,
      );
    }
    return candidate.map((component, componentIndex) => {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new Error(
          `Embedding vector ${vectorIndex}, component ${componentIndex} must be a finite number.`,
        );
      }
      return component;
    });
  });
}

function outputExcerpt(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return 'The command wrote no diagnostic output.';
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 2_000)}…`;
}

/**
 * A local provider backed by an explicitly configured process. The executable
 * is invoked directly: no shell performs interpolation, expansion, or pipes.
 */
export class CommandEmbeddingProvider implements EmbeddingProvider {
  readonly kind: string;
  readonly #argv: string[];

  constructor(argv: readonly string[]) {
    this.#argv = validateArgv([...argv], 'Embedding command');
    const identity = createHash('sha256')
      .update(JSON.stringify(this.#argv))
      .digest('hex')
      .slice(0, 16);
    this.kind = `command:${identity}`;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingVector[]> {
    if (!texts.every((text) => typeof text === 'string')) {
      throw new Error('Embedding input must contain only strings.');
    }
    if (texts.length === 0) return [];

    const [executable, ...args] = this.#argv;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let diagnostics = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        diagnostics += chunk;
      });
      child.once('error', (error) => {
        fail(new Error(`Could not start embedding executable "${executable}": ${error.message}`, { cause: error }));
      });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        // A process that exits early commonly closes stdin. Its exit status and
        // stderr are more useful than the resulting EPIPE.
        if (error.code !== 'EPIPE') {
          fail(new Error(`Could not send input to embedding executable "${executable}": ${error.message}`, { cause: error }));
        }
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`;
          reject(
            new Error(
              `Embedding executable "${executable}" failed with ${outcome}. ${outputExcerpt(diagnostics)}`,
            ),
          );
          return;
        }
        resolve(output);
      });

      child.stdin.end(JSON.stringify({ texts: [...texts] }));
    });

    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `Embedding command stdout was not valid JSON: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const vectors =
      decoded !== null &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      'vectors' in decoded
        ? (decoded as { vectors: unknown }).vectors
        : decoded;
    return validateVectors(vectors, texts.length);
  }
}

/** Resolve the current setting first, then its legacy ORCH_* alias. */
export function configuredEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | null {
  const source = env[CURRENT_COMMAND] !== undefined ? CURRENT_COMMAND : LEGACY_COMMAND;
  const raw = env[source];
  if (raw === undefined) return null;
  return new CommandEmbeddingProvider(parseConfiguredArgv(raw, source));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error('Cosine similarity requires non-empty vectors.');
  }
  if (a.length !== b.length) {
    throw new Error(`Cosine similarity requires equal dimensions; got ${a.length} and ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw new Error(`Cosine similarity component ${index} must be finite in both vectors.`);
    }
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function reciprocalRankScore(rank: number, k = 60): number {
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error(`Reciprocal rank must be a positive integer; got ${rank}.`);
  }
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`RRF k must be a finite non-negative number; got ${k}.`);
  }
  return 1 / (k + rank);
}

export function reciprocalRankFusion<T>(
  rankings: readonly (readonly T[])[],
  options: ReciprocalRankFusionOptions<T> = {},
): FusedRank<T>[] {
  const k = options.k ?? 60;
  // Validate even for empty input so a bad configuration never fails silently.
  reciprocalRankScore(1, k);
  const keyOf = options.key ?? ((item: T) => item);
  const fused = new Map<unknown, { item: T; score: number; firstSeen: number }>();
  let seenOrder = 0;

  for (const ranking of rankings) {
    const seenInRanking = new Set<unknown>();
    ranking.forEach((item, index) => {
      const key = keyOf(item);
      if (seenInRanking.has(key)) return;
      seenInRanking.add(key);
      const existing = fused.get(key);
      if (existing) {
        existing.score += reciprocalRankScore(index + 1, k);
      } else {
        fused.set(key, {
          item,
          score: reciprocalRankScore(index + 1, k),
          firstSeen: seenOrder,
        });
        seenOrder += 1;
      }
    });
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .map(({ item, score }) => ({ item, score }));
}
