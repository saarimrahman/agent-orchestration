import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

import {
  addComment,
  askForInput,
  claimTask,
  createProject,
  createTask,
  openDb,
} from '../core/index.ts';
import { createApp } from './index.ts';

/**
 * Renders the real UI against the real API. This is the closest thing to
 * opening the board in a browser that runs headless: it catches render crashes,
 * bad API shapes, and broken data flow, none of which the type checker or the
 * core tests can see.
 *
 * The app is bundled to IIFE here rather than reusing dist/, because jsdom
 * cannot execute ES module scripts.
 */

const ROOT = join(import.meta.dirname, '..', '..');

let server: { close: () => void; port: number } | null = null;

function seed() {
  const db = openDb(':memory:');
  createProject(db, 'demo', 'Demo');
  const parser = createTask(db, { title: 'Write the parser', project: 'demo', actor: 'you', priority: 1 });
  createTask(db, { title: 'Ship it', project: 'demo', actor: 'you', dependsOn: [parser.ref] });
  claimTask(db, parser.id, 'alice');
  addComment(db, parser.id, 'alice', 'skeleton done', 'progress');

  const schema = createTask(db, { title: 'Pick a schema', project: 'demo', actor: 'you' });
  askForInput(db, schema.id, 'bruno', 'Postgres or SQLite for the store?');
  return db;
}

before(async () => {
  const { serve } = await import('@hono/node-server');
  const app = createApp(seed());
  await new Promise<void>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      server = { close: () => instance.close(), port: info.port };
      resolve();
    });
  });
});

after(() => server?.close());

describe('api', () => {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/api${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  test('state carries everything the board needs in one call', async () => {
    const { body } = await call('/state');
    assert.ok(Array.isArray(body.projects) && body.projects.length > 0);
    assert.ok(Array.isArray(body.tasks) && body.tasks.length > 0);
    assert.ok(Array.isArray(body.events));
    assert.equal(typeof body.marker, 'number');
  });

  test('create, comment, and read back a task', async () => {
    const created = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'From the web', project: 'demo', priority: 0, due: '3d' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.priority, 0);
    assert.ok(created.body.due_at, 'a natural-language due date should resolve');

    await call(`/tasks/${created.body.ref}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'looks good', author: 'you' }),
    });

    const { body } = await call(`/tasks/${created.body.ref}`);
    assert.equal(body.comments.length, 1);
    assert.equal(body.comments[0].author, 'you');
  });

  test('patching status is the drag-and-drop path', async () => {
    const { body } = await call('/tasks/demo-2', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'review' }),
    });
    assert.equal(body.status, 'review');
  });

  test('claiming an already-held task is a conflict, not a silent success', async () => {
    const { status, body } = await call('/tasks/demo-1/claim', {
      method: 'POST',
      body: JSON.stringify({ agent: 'bob' }),
    });
    assert.equal(status, 409);
    assert.match(body.error, /not claimable/);
  });

  test('a bad request explains itself instead of returning a bare 500', async () => {
    const { status, body } = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', project: 'does-not-exist' }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /Existing projects/);
  });

  test('an agent can park a task with a question, and a human can clear it', async () => {
    const created = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Needs a call', project: 'demo' }),
    });
    const ref = created.body.ref;

    const parked = await call(`/tasks/${ref}/ask`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Which region?', actor: 'bruno' }),
    });
    assert.equal(parked.body.status, 'needs_input');
    assert.equal(parked.body.question, 'Which region?');
    assert.ok(
      (await call('/state')).body.needs_input.includes(ref),
      'the board should list it as waiting on a human',
    );

    const answered = await call(`/tasks/${ref}/answer`, {
      method: 'POST',
      body: JSON.stringify({ body: 'us-east-1', actor: 'you' }),
    });
    assert.equal(answered.body.status, 'ready');
    assert.equal(answered.body.question, null);
    assert.ok(!(await call('/state')).body.needs_input.includes(ref));
  });

  test('the change marker advances on every write', async () => {
    const before = (await call('/state')).body.marker;
    await call('/tasks', { method: 'POST', body: JSON.stringify({ title: 'tick', project: 'demo' }) });
    const after = (await call('/state')).body.marker;
    assert.ok(after > before, 'the SSE change signal must move when data changes');
  });
});

describe('web bundle', () => {
  test('renders the board without throwing', async () => {
    const bundled = await build({
      entryPoints: [join(ROOT, 'web', 'main.tsx')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    const base = `http://127.0.0.1:${server!.port}`;
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: base,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });

    const errors: string[] = [];
    dom.virtualConsole.on('jsdomError', (err: Error) => errors.push(err.message));
    dom.window.addEventListener('error', (e: ErrorEvent) => errors.push(e.message));

    const globals = dom.window as unknown as Record<string, unknown>;

    // jsdom has no EventSource; the board must still paint from the initial fetch.
    globals.EventSource = class {
      addEventListener() {}
      close() {}
      onerror = null;
    };
    // jsdom's fetch is not wired to the test server, so point it there.
    globals.fetch = (input: string, init?: RequestInit) =>
      fetch(new URL(String(input), base), init);

    const script = dom.window.document.createElement('script');
    script.textContent = bundled.outputFiles[0].text;
    dom.window.document.body.appendChild(script);

    // Let React mount and the initial /api/state round trip settle.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const text = dom.window.document.getElementById('root')?.textContent ?? '';
    assert.deepEqual(errors, [], 'the bundle should not raise runtime errors');
    assert.match(text, /Backlog/, 'the board columns should render');
    assert.match(text, /Write the parser/, 'seeded tasks should render');
    assert.match(text, /In progress/, 'status columns should render');
    assert.match(text, /alice/, 'the activity feed should show agent actions');
    assert.match(text, /Needs you/, 'the waiting-on-a-human column should render');
    assert.match(
      text,
      /Postgres or SQLite for the store\?/,
      'the question should be readable on the board without opening the task',
    );
    assert.match(text, /waiting on your answer/, 'the banner should call out pending questions');

    dom.window.close();
  });
});
