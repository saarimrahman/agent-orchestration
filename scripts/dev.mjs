#!/usr/bin/env node

/**
 * `npm run dev` — the API server and the Vite dev server together.
 *
 * These have to run as two processes (Vite needs to own its own port to do hot
 * reload), but requiring two terminals is a reliable way to end up staring at a
 * port with nothing listening on it. This starts both, prefixes their output,
 * and shuts both down on ctrl-c.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const API_PORT = process.env.ORCH_PORT ?? '4477';
const WEB_PORT = process.env.ORCH_WEB_PORT ?? '4478';

const colors = { api: '\x1b[36m', web: '\x1b[35m', reset: '\x1b[0m' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(name, text) {
  return useColor ? `${colors[name]}${name}${colors.reset} ${text}` : `${name} ${text}`;
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(paint(name, line));
    });
  }

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(paint(name, `exited with code ${code}`));
      shutdown(code);
    }
  });

  return child;
}

const children = [];
let closing = false;

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

children.push(
  start('api', process.execPath, [join(ROOT, 'bin', 'orch'), 'ui', '--port', API_PORT, '--no-open'], {}),
);
children.push(
  start('web', 'npx', ['vite', '--port', WEB_PORT, '--strictPort'], {
    ORCH_API_PORT: API_PORT,
  }),
);

console.log('');
console.log(`  Board (hot reload)  http://127.0.0.1:${WEB_PORT}`);
console.log(`  API                 http://127.0.0.1:${API_PORT}`);
console.log('');
console.log('  Open the first one. Ctrl-C stops both.');
console.log('');
