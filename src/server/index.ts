import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { exec } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join, relative as relPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addComment,
  addDep,
  answerInput,
  askForInput,
  awaitingInput,
  changeMarker,
  claimTask,
  createProject,
  createTask,
  deleteTask,
  attachTag,
  detachTag,
  listComments,
  listEvents,
  listMemories,
  listProjects,
  listTags,
  listTasks,
  parseWhenOrThrow,
  readyTasks,
  recentEvents,
  releaseTask,
  removeDep,
  requireTask,
  resolveMemoryPath,
  setStatus,
  staleLeases,
  updateMemory,
  updateTask,
  type Db,
  type MemoryKind,
  type MemoryStatus,
  type Status,
} from '../core/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');

type Body = Record<string, unknown>;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Distinguish "field omitted" from "field explicitly cleared". */
function optionalDate(body: Body, key: string): Date | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === '') return null;
  return parseWhenOrThrow(String(raw));
}

const COOKIE = 'orch_token';

/**
 * Shared-secret gate, used only when the server is reachable off-loopback.
 *
 * The token arrives once as `?t=…`, is exchanged for a cookie, and is stripped
 * from the URL so it does not linger in history or get pasted into a chat. A
 * header works too, for curl and scripts. EventSource cannot set headers, but
 * it does send cookies, so the SSE stream is covered by the same check.
 */
function tokenGate(token: string) {
  return async (ctx: Context, next: Next) => {
    const url = new URL(ctx.req.url);

    if (url.searchParams.get('t') === token) {
      setCookie(ctx, COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24 * 30,
      });
      url.searchParams.delete('t');
      return ctx.redirect(url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ''));
    }

    if (getCookie(ctx, COOKIE) === token || ctx.req.header('x-orch-token') === token) {
      return next();
    }

    return ctx.text(
      'This board needs the access token.\n\n' +
        'Open the full URL printed by `orch ui`, the one ending in ?t=…\n',
      401,
    );
  };
}

export function createApp(
  db: Db,
  options: { token?: string; memoryRoot?: string } = {},
) {
  const app = new Hono();

  // Core throws plain Errors carrying guidance meant for the caller, so pass the
  // message through as a 400 and log one line rather than a stack.
  app.onError((err, ctx) => {
    console.warn(`${ctx.req.method} ${ctx.req.path} — ${err.message}`);
    return ctx.json({ error: err.message }, 400);
  });

  if (options.token) app.use('*', tokenGate(options.token));

  const allMemories = () => {
    const root = options.memoryRoot ?? resolveMemoryPath();
    const memories = new Map(
      listMemories(db, root, null, { all: true, limit: 1_000 }).map((memory) => [memory.id, memory]),
    );
    for (const project of listProjects(db, true)) {
      for (const memory of listMemories(db, root, project, { all: true, limit: 1_000 })) {
        memories.set(memory.id, memory);
      }
    }
    return {
      root,
      memories: [...memories.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    };
  };

  /** Everything the board needs for a first paint, in one round trip. */
  app.get('/api/state', (ctx) => {
    const includeClosed = ctx.req.query('closed') === '1';
    return ctx.json({
      projects: listProjects(db, true),
      tags: listTags(db),
      tasks: listTasks(db, { includeClosed }),
      recently_closed: includeClosed
        ? []
        : listTasks(db, { status: ['done', 'cancelled'], limit: 40 }),
      ready: readyTasks(db).map((t) => t.ref),
      needs_input: awaitingInput(db).map((t) => t.ref),
      stale_leases: staleLeases(db).map((t) => t.ref),
      events: recentEvents(db, 60),
      marker: changeMarker(db),
    });
  });

  /** All durable memory, across global and project scopes, for the board. */
  app.get('/api/memories', (ctx) => {
    return ctx.json(allMemories().memories);
  });

  app.patch('/api/memories/:id', async (ctx) => {
    const { root, memories } = allMemories();
    const current = memories.find((memory) => memory.id === ctx.req.param('id'));
    if (!current) throw new Error(`No memory "${ctx.req.param('id')}".`);
    const project = current.project_key
      ? listProjects(db, true).find((item) => item.key === current.project_key) ?? null
      : null;
    const body = (await ctx.req.json()) as Body;
    const updated = updateMemory(db, root, project, current.id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      body: typeof body.body === 'string' ? body.body : undefined,
      kind: typeof body.kind === 'string' ? body.kind as MemoryKind : undefined,
      status: typeof body.status === 'string' ? body.status as MemoryStatus : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined,
    });
    return ctx.json(updated);
  });

  app.get('/api/tasks/:ref', (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    return ctx.json({
      ...task,
      comments: listComments(db, task.id),
      events: listEvents(db, task.id),
    });
  });

  app.post('/api/tasks', async (ctx) => {
    const body = (await ctx.req.json()) as Body;
    const task = createTask(db, {
      title: String(body.title ?? ''),
      project: asString(body.project),
      body: asString(body.body),
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      status: asString(body.status) as Status | undefined,
      dueAt: optionalDate(body, 'due') ?? null,
      recur: asString(body.recur) ?? null,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      dependsOn: Array.isArray(body.deps) ? (body.deps as string[]) : [],
      actor: asString(body.actor) ?? 'web',
    });
    return ctx.json(task, 201);
  });

  app.patch('/api/tasks/:ref', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json()) as Body;
    const actor = asString(body.actor) ?? 'web';

    if (typeof body.status === 'string') {
      setStatus(db, task.id, body.status as Status, actor);
    }

    updateTask(
      db,
      task.id,
      {
        title: asString(body.title),
        body: typeof body.body === 'string' ? body.body : undefined,
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        project: asString(body.project),
        assignee: 'assignee' in body ? ((body.assignee as string | null) ?? null) : undefined,
        dueAt: optionalDate(body, 'due'),
        snoozeUntil: optionalDate(body, 'snooze'),
        recur: 'recur' in body ? ((body.recur as string | null) || null) : undefined,
      },
      actor,
    );

    if (Array.isArray(body.addTags)) {
      for (const tag of body.addTags as string[]) attachTag(db, task.id, tag);
    }
    if (Array.isArray(body.removeTags)) {
      for (const tag of body.removeTags as string[]) detachTag(db, task.id, tag);
    }

    return ctx.json(requireTask(db, task.ref));
  });

  app.delete('/api/tasks/:ref', (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    deleteTask(db, task.id, ctx.req.query('actor') ?? 'web');
    return ctx.json({ deleted: task.ref });
  });

  app.post('/api/tasks/:ref/comments', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json()) as Body;
    const comment = addComment(
      db,
      task.id,
      asString(body.author) ?? 'web',
      String(body.body ?? ''),
      body.kind === 'progress' ? 'progress' : 'note',
    );
    return ctx.json(comment, 201);
  });

  app.post('/api/tasks/:ref/ask', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json()) as Body;
    const result = askForInput(db, task.id, asString(body.actor) ?? 'web', String(body.body ?? ''));
    return ctx.json(result.task);
  });

  app.post('/api/tasks/:ref/answer', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json()) as Body;
    const result = answerInput(db, task.id, asString(body.actor) ?? 'you', String(body.body ?? ''));
    return ctx.json(result.task);
  });

  app.post('/api/tasks/:ref/claim', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json().catch(() => ({}))) as Body;
    const claimed = claimTask(db, task.id, asString(body.agent) ?? 'web');
    if (!claimed) return ctx.json({ error: `${task.ref} is not claimable right now.` }, 409);
    return ctx.json(claimed);
  });

  app.post('/api/tasks/:ref/release', (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    return ctx.json(releaseTask(db, task.id, ctx.req.query('actor') ?? 'web'));
  });

  app.post('/api/tasks/:ref/deps', async (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const body = (await ctx.req.json()) as Body;
    const blocker = requireTask(db, String(body.blocker));
    addDep(db, task.id, blocker.id, 'blocks');
    return ctx.json(requireTask(db, task.ref));
  });

  app.delete('/api/tasks/:ref/deps/:blocker', (ctx) => {
    const task = requireTask(db, ctx.req.param('ref'));
    const blocker = requireTask(db, ctx.req.param('blocker'));
    removeDep(db, task.id, blocker.id, 'blocks');
    return ctx.json(requireTask(db, task.ref));
  });

  app.post('/api/projects', async (ctx) => {
    const body = (await ctx.req.json()) as Body;
    return ctx.json(
      createProject(db, String(body.key ?? ''), asString(body.name), asString(body.color)),
      201,
    );
  });

  /**
   * Live updates. Writes arrive from separate CLI processes, so an in-process
   * hook would miss them; polling the max event id is the reliable signal and
   * costs a single indexed lookup.
   */
  app.get('/api/stream', (ctx) =>
    streamSSE(ctx, async (stream) => {
      // `closed` alone is not enough to end the loop: a client that goes away
      // without a clean close leaves it polling SQLite forever, so every shut
      // browser tab would leak a timer for the life of the process. Watch the
      // abort paths too.
      let done = false;
      const stop = () => {
        done = true;
      };
      stream.onAbort(stop);
      ctx.req.raw.signal?.addEventListener('abort', stop, { once: true });

      let last = -1;
      while (!done && !stream.closed && !stream.aborted) {
        const marker = changeMarker(db);
        if (marker !== last) {
          last = marker;
          await stream.writeSSE({ event: 'change', data: String(marker) });
        }
        await stream.sleep(750);
      }
    }),
  );

  if (existsSync(join(DIST, 'index.html'))) {
    const root = relPath(process.cwd(), DIST) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  } else {
    app.get('*', (ctx) =>
      ctx.text(
        'The web UI has not been built yet.\n\n' +
          'Run "npm run build" once, then "orch ui" again.\n' +
          'For UI development run "npm run dev:web" in a second terminal.\n',
        503,
      ),
    );
  }

  return app;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${command} ${url}`, () => {
    /* opening a browser is a convenience; never fail the server over it */
  });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export type ServeOptions = {
  port?: number;
  open?: boolean;
  /** Interface to bind. Anything other than loopback exposes the board. */
  host?: string;
  /** Shared secret. Required automatically when host is not loopback. */
  token?: string;
};

export function startServer(db: Db, opts: ServeOptions = {}): Promise<void> {
  const port = opts.port ?? 4477;
  const host = opts.host ?? '127.0.0.1';
  const exposed = !isLoopback(host);
  const app = createApp(db, { token: opts.token });

  return new Promise(() => {
    serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      const shown = exposed ? (hostname() ?? host) : '127.0.0.1';
      const suffix = opts.token ? `/?t=${opts.token}` : '';
      const url = `http://${shown}:${info.port}${suffix}`;

      if (exposed) {
        console.log('');
        console.log(`  Board   ${url}`);
        console.log('');
        console.log(`  Reachable from the network on port ${info.port}.`);
        console.log(
          opts.token
            ? '  The token in that URL is required. Open the whole link.'
            : '  No token: anyone who can reach this host can read and change your tasks.',
        );
        console.log('');
      } else {
        console.log(`orch board  ${url}`);
        console.log('press ctrl-c to stop');
      }

      if (opts.open !== false && !exposed) openBrowser(url);
    });
  });
}
