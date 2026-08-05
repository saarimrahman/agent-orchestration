export type Parsed = {
  positional: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
};

/** Single-letter aliases, expanded before anything else looks at the flags. */
const ALIASES: Record<string, string> = {
  p: 'project',
  P: 'priority',
  t: 'tag',
  a: 'agent',
  m: 'message',
  b: 'body',
  d: 'due',
  n: 'limit',
  j: 'json',
  h: 'help',
};

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'claim',
  'progress',
  'all',
  'closed',
  'open',
  'no-open',
  'force',
  'quiet',
  'version',
  'no-auth',
  'global',
  'candidate',
  'verified',
]);

function expand(name: string): string {
  return ALIASES[name] ?? name;
}

/**
 * Parse argv into positionals and flags. Repeated flags accumulate, so
 * `--tag api --tag db` yields both. `--` stops flag parsing.
 */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();

  const push = (name: string, value: string) => {
    const list = flags.get(name);
    if (list) list.push(value);
    else flags.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        push(expand(body.slice(0, eq)), body.slice(eq + 1));
        continue;
      }
      const name = expand(body);
      if (BOOLEAN_FLAGS.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('-')) {
        bools.add(name);
      } else {
        push(name, argv[++i]);
      }
      continue;
    }

    // A lone "-" or a negative number is a positional, not a flag.
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const letter = arg[1];
      const name = expand(letter);
      const attached = arg.slice(2);
      if (attached) {
        push(name, attached);
      } else if (
        BOOLEAN_FLAGS.has(name) ||
        argv[i + 1] === undefined ||
        argv[i + 1].startsWith('-')
      ) {
        bools.add(name);
      } else {
        push(name, argv[++i]);
      }
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags, bools };
}

export function str(p: Parsed, name: string): string | undefined {
  return p.flags.get(name)?.at(-1);
}

export function list(p: Parsed, name: string): string[] {
  return (p.flags.get(name) ?? []).flatMap((v) =>
    v.split(',').map((s) => s.trim()).filter(Boolean),
  );
}

export function bool(p: Parsed, name: string): boolean {
  return p.bools.has(name);
}

export function num(p: Parsed, name: string): number | undefined {
  const raw = str(p, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} needs a number. Got "${raw}".`);
  }
  return value;
}

/** True when the flag was given at all, in either boolean or valued form. */
export function present(p: Parsed, name: string): boolean {
  return p.bools.has(name) || p.flags.has(name);
}
