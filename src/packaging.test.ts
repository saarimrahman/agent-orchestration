import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentsBlock, skillFile } from './core/instructions.ts';

/**
 * Guards against the ways this project can be broken from the outside rather
 * than in the code: a documented command that does not exist, or a build that
 * writes somewhere the server does not read from. Both produce a blank page
 * with no error, which is the worst kind of failure to debug.
 */

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

describe('packaging', () => {
  test('every npm script the README tells you to run exists', () => {
    const mentioned = [...readme.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
    assert.ok(mentioned.length > 0, 'the README should document some scripts');

    const missing = [...new Set(mentioned)].filter((name) => !(name in pkg.scripts));
    assert.deepEqual(missing, [], `README references scripts that do not exist: ${missing}`);
  });

  test('the dev entrypoint is called `dev`', () => {
    // `npm run dev` is what everyone types. If the script is named anything
    // else, the command fails silently and the dev server never starts.
    assert.ok(pkg.scripts.dev, 'there must be a plain `dev` script');
  });

  test('the build writes where the server looks for it', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    const root = /root:\s*'([^']+)'/.exec(config)?.[1];
    const outDir = /outDir:\s*'([^']+)'/.exec(config)?.[1];
    assert.ok(root && outDir, 'vite config should declare root and outDir');

    // src/server/index.ts serves <repo>/dist
    const served = resolve(ROOT, 'dist');
    const built = resolve(ROOT, root, outDir);
    assert.equal(built, served, 'vite outDir must match the directory the server serves');
  });

  test('the SDK is published as compiled JavaScript outside the replaceable UI build', () => {
    assert.equal(pkg.exports['.'].import, './lib/sdk.js');
    assert.equal(pkg.exports['.'].types, './lib/sdk.d.ts');
    assert.equal(pkg.exports['./core'].import, './lib/core/index.js');
    assert.ok(pkg.files.includes('lib'), 'the packed package must include compiled SDK files');
    assert.match(pkg.scripts['build:sdk'], /--outDir lib/);
    assert.match(pkg.scripts.build, /build:sdk/);
  });

  test('the server and the dev proxy agree on the API port', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    const proxyPort = /ORCHESTRATION_API_PORT \?\? process\.env\.ORCH_API_PORT \?\? (\d+)/.exec(config)?.[1];
    const serverDefault = /num\(p, 'port'\) \?\? (\d+)/.exec(
      readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf8'),
    )?.[1];

    assert.ok(proxyPort && serverDefault, 'both ports should be discoverable');
    assert.equal(proxyPort, serverDefault, 'the dev proxy must point at the API default port');
  });

  test('the dev proxy does not swallow the frontend api.ts module', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(config, /['"]\^\/api\/['"]\s*:/, 'only /api/ routes should be proxied');
    assert.doesNotMatch(
      config,
      /['"]\/api['"]\s*:/,
      'a broad /api prefix also matches /api.ts and produces a blank page',
    );
  });

  test('the dev server defaults to IPv4 loopback so 127.0.0.1 resolves', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    // Vite's own default binds ::1 only, which makes http://127.0.0.1 refuse
    // connections and look exactly like a broken app.
    assert.match(config, /ORCHESTRATION_HOST \?\? process\.env\.ORCH_HOST \?\? '127\.0\.0\.1'/);
    assert.match(config, /host,/, 'the resolved host must be passed to the server');
  });

  test('exposing the dev server relaxes the Host header check', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    // Otherwise reaching a dev box by its own hostname returns Vite's
    // "Blocked request" page, which reads as a broken app.
    assert.match(config, /allowedHosts: exposed \? true : undefined/);
  });

  test('checked-in agent instructions match the generated workflow', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const skill = readFileSync(join(ROOT, '.claude', 'skills', 'orchestration', 'SKILL.md'), 'utf8');

    assert.ok(agents.includes(agentsBlock().trim()), 'AGENTS.md must match the workflow source');
    assert.equal(skill, skillFile(), 'the installed skill must match the workflow source');
  });
});
