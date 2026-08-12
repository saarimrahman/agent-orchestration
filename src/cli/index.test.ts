import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uiBuildFingerprint, uiBuildIsFresh } from './index.ts';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-ui-build-'));
  roots.push(root);
  mkdirSync(join(root, 'web'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'vite.config.ts'), 'export default {}');
  writeFileSync(join(root, 'web', 'main.tsx'), 'export const version = 1;');
  writeFileSync(join(root, 'dist', 'index.html'), '<div id="root"></div>');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UI build freshness', () => {
  test('rejects an unstamped bundle and accepts a matching source fingerprint', () => {
    const root = fixture();
    assert.equal(uiBuildIsFresh(root), false);

    writeFileSync(join(root, 'dist', '.orchestration-ui-build.json'), JSON.stringify({
      version: 1,
      fingerprint: uiBuildFingerprint(root),
    }));
    assert.equal(uiBuildIsFresh(root), true);
  });

  test('invalidates the bundle after any board source changes', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist', '.orchestration-ui-build.json'), JSON.stringify({
      version: 1,
      fingerprint: uiBuildFingerprint(root),
    }));

    writeFileSync(join(root, 'web', 'main.tsx'), 'export const version = 2;');
    assert.equal(uiBuildIsFresh(root), false);
  });

  test('accepts a packaged prebuilt bundle when frontend source is not shipped', () => {
    const root = fixture();
    rmSync(join(root, 'web'), { recursive: true });
    assert.equal(uiBuildIsFresh(root), true);
  });
});
