import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  rememberMemory,
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
let uiMemoryRoot = '';

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
  uiMemoryRoot = mkdtempSync(join(tmpdir(), 'orchestration-ui-memory-'));
  const db = seed();
  rememberMemory(db, uiMemoryRoot, {
    title: 'Browser memory',
    body: 'Visible and editable from the board.',
    tags: ['browser', 'ui'],
    project: null,
  });
  rememberMemory(db, uiMemoryRoot, {
    title: 'Alpha memory',
    body: 'A second memory for browsing controls.',
    kind: 'fact',
    status: 'candidate',
    tags: ['docs'],
    project: null,
  });
  const app = createApp(db, { memoryRoot: uiMemoryRoot });
  await new Promise<void>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      server = { close: () => instance.close(), port: info.port };
      resolve();
    });
  });
});

after(() => {
  server?.close();
  rmSync(uiMemoryRoot, { recursive: true, force: true });
});

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

  test('memory view returns global and every project scope, including archived entries', async () => {
    const db = openDb(':memory:');
    const project = createProject(db, 'docs', 'Docs');
    const root = mkdtempSync(join(tmpdir(), 'orchestration-memory-api-'));
    try {
      const shared = rememberMemory(db, root, {
        title: 'Shared rule',
        body: 'Use small commits.',
        project: null,
      });
      rememberMemory(db, root, {
        title: 'Old project note',
        body: 'Retained for history.',
        status: 'archived',
        project,
      });

      const app = createApp(db, { memoryRoot: root });
      const res = await app.request('http://x/api/memories');
      assert.equal(res.status, 200);
      const memories = (await res.json()) as { title: string; project_key: string | null; status: string }[];
      assert.deepEqual(
        memories.map((memory) => [memory.title, memory.project_key, memory.status]).sort(),
        [
          ['Old project note', 'docs', 'archived'],
          ['Shared rule', null, 'active'],
        ],
      );

      const patched = await app.request(`http://x/api/memories/${shared.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Shared convention',
          body: 'Use small, verified commits.',
          kind: 'playbook',
          status: 'candidate',
          tags: ['git'],
          sources: ['docs-1'],
        }),
      });
      assert.equal(patched.status, 200);
      const updated = await patched.json() as Record<string, unknown>;
      assert.equal(updated.id, shared.id);
      assert.equal(updated.title, 'Shared convention');
      assert.equal(updated.body, 'Use small, verified commits.');
      assert.equal(updated.kind, 'playbook');
      assert.equal(updated.status, 'candidate');
      assert.deepEqual(updated.tags, ['git']);
      assert.deepEqual(updated.sources, ['docs-1']);

      const deleted = await app.request(`http://x/api/memories/${shared.id}`, {
        method: 'DELETE',
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { deleted: shared.id });

      const afterDelete = await app.request('http://x/api/memories');
      const remaining = (await afterDelete.json()) as { id: string }[];
      assert.equal(remaining.some((memory) => memory.id === shared.id), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('live update stream', () => {
  test('the poll loop stops when the client goes away', async () => {
    const db = seed();

    // Count queries rather than inspecting timers: if the loop is still alive
    // it keeps hitting SQLite every 750ms, and that is directly observable.
    let queries = 0;
    const realPrepare = db.prepare.bind(db);
    (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      queries += 1;
      return realPrepare(sql);
    };

    const res = await createApp(db).request('http://x/api/stream');
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 1_600));
    assert.ok(queries > 0, 'the stream should be polling while a client is attached');

    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 400));

    const afterCancel = queries;
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(
      queries,
      afterCancel,
      'polling must stop once the client disconnects, or every closed tab leaks a timer',
    );
  });
});

describe('access token', () => {
  // Exercised against a second app instance so the main suite stays ungated.
  const gated = createApp(seed(), { token: 'sekret' });
  const hit = (path: string, init?: RequestInit) =>
    gated.request(`http://board.local${path}`, init);

  test('blocks everything without the token', async () => {
    for (const path of ['/', '/api/state', '/api/stream', '/api/tasks/demo-1']) {
      assert.equal((await hit(path)).status, 401, `${path} should be gated`);
    }
  });

  test('blocks writes too, not just reads', async () => {
    const res = await hit('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'sneaky', project: 'demo' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 401);
  });

  test('a wrong token is rejected', async () => {
    assert.equal((await hit('/api/state?t=guess')).status, 401);
    assert.equal(
      (await hit('/api/state', { headers: { 'x-orchestration-token': 'guess' } })).status,
      401,
    );
  });

  test('?t= exchanges for a cookie and drops the token from the URL', async () => {
    const res = await hit('/?t=sekret');
    assert.equal(res.status, 302);

    const location = res.headers.get('location') ?? '';
    assert.ok(!location.includes('sekret'), 'the token must not survive in the redirect target');

    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /orchestration_token=sekret/);
    assert.match(cookie, /HttpOnly/, 'the cookie should not be readable from JavaScript');
  });

  test('the cookie carries subsequent requests, including the SSE stream', async () => {
    const headers = { cookie: 'orchestration_token=sekret' };
    assert.equal((await hit('/api/state', { headers })).status, 200);

    // EventSource cannot set headers, so cookie auth is what makes live
    // updates work behind the gate. The stream loops until the client goes
    // away, so cancel the body or it keeps the event loop alive forever.
    const stream = await hit('/api/stream', { headers });
    assert.equal(stream.status, 200);
    await stream.body?.cancel();
  });

  test('a header works for curl and scripts', async () => {
    const res = await hit('/api/state', { headers: { 'x-orchestration-token': 'sekret' } });
    assert.equal(res.status, 200);
  });

  test('other query parameters survive the redirect', async () => {
    const res = await hit('/api/state?t=sekret&closed=1');
    assert.match(res.headers.get('location') ?? '', /closed=1/);
    assert.ok(!(res.headers.get('location') ?? '').includes('sekret'));
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

    const activityResize = dom.window.document.querySelector(
      '[role="separator"][aria-label="Resize activity panel"]',
    );
    assert.ok(activityResize, 'the activity panel should expose an accessible resize handle');
    const activityWidth = Number(activityResize.getAttribute('aria-valuenow'));
    activityResize.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      Number(activityResize.getAttribute('aria-valuenow')),
      activityWidth + 20,
      'the activity panel should resize from the keyboard',
    );

    const parserCard = [...dom.window.document.querySelectorAll('article')]
      .find((article) => article.textContent?.includes('Write the parser'));
    assert.ok(parserCard, 'the seeded task should be clickable');
    parserCard.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const taskResize = dom.window.document.querySelector(
      '[role="separator"][aria-label="Resize task details panel"]',
    );
    assert.ok(taskResize, 'the task drawer should expose an accessible resize handle');
    const taskWidth = Number(taskResize.getAttribute('aria-valuenow'));
    taskResize.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      Number(taskResize.getAttribute('aria-valuenow')),
      taskWidth + 20,
      'the task drawer should resize from the keyboard',
    );
    const closeTask = dom.window.document.querySelector('button[aria-label="Close task"]');
    assert.ok(closeTask);
    closeTask.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const memoryButton = [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Memory');
    assert.ok(memoryButton, 'memory should be reachable from the board sidebar');
    memoryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const memoryText = dom.window.document.getElementById('root')?.textContent ?? '';
    assert.match(memoryText, /Durable memory/);
    assert.match(memoryText, /Browser memory/);
    assert.doesNotMatch(memoryText, /Visible and editable from the board/);
    assert.ok(dom.window.document.querySelector('select[aria-label="Filter memories by kind"]'));
    assert.ok(dom.window.document.querySelector('select[aria-label="Filter memories by status"]'));
    assert.ok(dom.window.document.querySelector('select[aria-label="Filter memories by scope"]'));

    const rows = () => [...dom.window.document.querySelectorAll('button[aria-label^="View memory:"]')];
    let memoryRow = dom.window.document.querySelector('button[aria-label="View memory: Browser memory"]');
    assert.ok(memoryRow, 'each compact memory title should open its detail');
    assert.match(memoryRow.textContent ?? '', /#browser/);
    assert.match(memoryRow.textContent ?? '', /#ui/);

    const sortSelect = dom.window.document.querySelector('select[aria-label="Sort memories"]') as HTMLSelectElement;
    sortSelect.value = 'title-asc';
    sortSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rows()[0]?.getAttribute('aria-label'), 'View memory: Alpha memory');

    const tagSelect = dom.window.document.querySelector('select[aria-label="Filter memories by tag"]') as HTMLSelectElement;
    tagSelect.value = 'ui';
    tagSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rows().map((row) => row.getAttribute('aria-label')), ['View memory: Browser memory']);

    memoryRow = dom.window.document.querySelector('button[aria-label="View memory: Browser memory"]');
    assert.ok(memoryRow);
    memoryRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(dom.window.document.getElementById('root')?.textContent ?? '', /Visible and editable from the board/);
    const editButton = [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Edit memory');
    assert.ok(editButton, 'memory detail should offer an edit action');
    editButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(dom.window.document.getElementById('root')?.textContent ?? '', /Edit memory/);
    const deleteButton = [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Delete');
    assert.ok(deleteButton, 'memory editing should offer a delete action');
    deleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(dom.window.document.getElementById('root')?.textContent ?? '', /Delete “Browser memory”\?/);

    dom.window.close();
  });

  test('an empty queue presents a clear first-task action', async () => {
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

    const globals = dom.window as unknown as Record<string, unknown>;
    globals.EventSource = class {
      addEventListener() {}
      close() {}
      onerror = null;
    };
    globals.fetch = async (input: string, init?: RequestInit) => {
      const response = await fetch(new URL(String(input), base), init);
      if (new URL(String(input), base).pathname !== '/api/state') return response;

      const state = await response.json();
      return Response.json({ ...state, tasks: [], recently_closed: [] });
    };

    const script = dom.window.document.createElement('script');
    script.textContent = bundled.outputFiles[0].text;
    dom.window.document.body.appendChild(script);
    await new Promise((resolve) => setTimeout(resolve, 900));

    const text = dom.window.document.getElementById('root')?.textContent ?? '';
    assert.match(text, /Your board is ready/);
    assert.match(text, /Create first task/);
    assert.match(text, /Backlog/, 'the Kanban columns should remain visible when empty');

    dom.window.close();
  });
});
