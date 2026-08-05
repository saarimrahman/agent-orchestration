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
import { hostname } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const API_PORT = process.env.ORCH_PORT ?? '4477';
const WEB_PORT = process.env.ORCH_WEB_PORT ?? '4478';

// `--host` with no value means all interfaces, matching every other dev server.
const hostArg = process.argv.indexOf('--host');
const HOST =
  hostArg === -1
    ? (process.env.ORCH_HOST ?? '127.0.0.1')
    : (process.argv[hostArg + 1]?.startsWith('-') ? null : process.argv[hostArg + 1]) ?? '0.0.0.0';
const EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST);

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

// The API server stays on loopback even when the board is exposed: Vite proxies
// /api server-side, so nothing needs to reach the API directly from outside.
children.push(
  start('api', process.execPath, [join(ROOT, 'bin', 'orch'), 'ui', '--port', API_PORT, '--no-open'], {}),
);
children.push(
  start('web', 'npx', ['vite', '--port', WEB_PORT, '--strictPort', '--host', HOST], {
    ORCH_API_PORT: API_PORT,
    ORCH_HOST: HOST,
  }),
);

const shown = EXPOSED ? hostname() : '127.0.0.1';

console.log('');
console.log(`  Board (hot reload)  http://${shown}:${WEB_PORT}`);
console.log(`  API                 http://127.0.0.1:${API_PORT}`);
console.log('');
if (EXPOSED) {
  console.log('  Reachable from the network, with no access token.');
  console.log('  Prefer an SSH tunnel from your laptop:');
  console.log(`    ssh -N -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} ${hostname()}`);
  console.log('');
}
console.log('  Open the first one. Ctrl-C stops both.');
console.log('');
