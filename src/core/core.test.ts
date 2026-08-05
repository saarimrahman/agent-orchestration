import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, tx, type Db } from './db.ts';
import { createProject } from './projects.ts';
import {
  addDep,
  claimNext,
  claimTask,
  createTask,
  listTasks,
  readyTasks,
  releaseTask,
  requireTask,
  setStatus,
  staleLeases,
  updateTask,
} from './tasks.ts';
import {
  addComment,
  answerInput,
  askForInput,
  awaitingInput,
  digest,
  listComments,
} from './activity.ts';
import { mergeAgentsFile } from './instructions.ts';
import { nextCronFire, parseDuration, parseWhen } from './time.ts';

let db: Db;

function fresh(): Db {
  const d = openDb(':memory:');
  createProject(d, 'demo', 'Demo');
  return d;
}

function add(title: string, extra: Record<string, unknown> = {}) {
  return createTask(db, { title, project: 'demo', actor: 'test', ...extra });
}

const refs = (list: { ref: string }[]) => list.map((t) => t.ref);

beforeEach(() => {
  db = fresh();
});

describe('ready queue', () => {
  test('surfaces unblocked tasks and hides blocked ones', () => {
    const parser = add('Write the parser');
    const ship = add('Ship it', { dependsOn: [parser.ref] });

    assert.deepEqual(refs(readyTasks(db)), [parser.ref]);
    assert.deepEqual(requireTask(db, ship.ref).blocked_by, [parser.ref]);
  });

  test('closing a blocker releases its dependents', () => {
    const parser = add('Write the parser');
    const ship = add('Ship it', { dependsOn: [parser.ref] });

    setStatus(db, parser.id, 'done', 'test');
    assert.deepEqual(refs(readyTasks(db)), [ship.ref]);
  });

  test('a cancelled blocker also unblocks', () => {
    const blocker = add('Abandoned approach');
    const dependent = add('Follow-up', { dependsOn: [blocker.ref] });

    setStatus(db, blocker.id, 'cancelled', 'test');
    assert.deepEqual(refs(readyTasks(db)), [dependent.ref]);
  });

  test('snoozed tasks leave the queue and come back on their own', () => {
    const task = add('Later');
    updateTask(db, task.id, { snoozeUntil: new Date(Date.now() + 60_000) }, 'test');
    assert.deepEqual(readyTasks(db), []);

    updateTask(db, task.id, { snoozeUntil: new Date(Date.now() - 1_000) }, 'test');
    assert.deepEqual(refs(readyTasks(db)), [task.ref]);
  });

  test('orders overdue first, then by priority, then by due date', () => {
    const hour = 3_600_000;
    const lowPriorityOverdue = add('overdue', {
      priority: 3,
      dueAt: new Date(Date.now() - hour),
    });
    const urgent = add('p0', { priority: 0 });
    const soon = add('due soon', { priority: 2, dueAt: new Date(Date.now() + hour) });
    const undated = add('no date', { priority: 2 });

    assert.deepEqual(refs(readyTasks(db)), [
      lowPriorityOverdue.ref,
      urgent.ref,
      soon.ref,
      undated.ref,
    ]);
  });

  test('excludes tasks in archived projects', () => {
    createProject(db, 'old', 'Old');
    const task = createTask(db, { title: 'Legacy', project: 'old', actor: 'test' });
    assert.deepEqual(refs(readyTasks(db)), [task.ref]);

    db.prepare("UPDATE projects SET archived_at = '2020-01-01T00:00:00.000Z' WHERE key = 'old'").run();
    assert.deepEqual(readyTasks(db), []);
  });

  test('filters by project and tag', () => {
    createProject(db, 'other', 'Other');
    add('demo task', { tags: ['api'] });
    createTask(db, { title: 'other task', project: 'other', actor: 'test' });

    assert.deepEqual(refs(readyTasks(db, { project: 'demo' })), ['demo-1']);
    assert.deepEqual(refs(readyTasks(db, { tag: 'api' })), ['demo-1']);
    assert.deepEqual(readyTasks(db, { tag: 'nope' }), []);
  });
});

describe('claiming', () => {
  test('exactly one of many concurrent claims wins', () => {
    const task = add('Contended');
    const results = Array.from({ length: 8 }, (_, i) =>
      claimTask(db, task.id, `agent-${i}`),
    );

    assert.equal(results.filter(Boolean).length, 1, 'exactly one claim should succeed');
    assert.equal(requireTask(db, task.ref).status, 'in_progress');
  });

  test('a claimed task disappears from the queue', () => {
    const task = add('Work');
    claimTask(db, task.id, 'alice');
    assert.deepEqual(readyTasks(db), []);
  });

  test('blocked tasks cannot be claimed even by id', () => {
    const blocker = add('Blocker');
    const dependent = add('Dependent', { dependsOn: [blocker.ref] });
    assert.equal(claimTask(db, dependent.id, 'alice'), null);
  });

  test('an expired lease returns the task to the queue', () => {
    const task = add('Abandoned');
    claimTask(db, task.id, 'alice', -1_000); // already expired

    assert.deepEqual(refs(staleLeases(db)), [task.ref]);
    const stolen = claimTask(db, task.id, 'bob');
    assert.equal(stolen?.assignee, 'bob');
  });

  test('claimNext skips past tasks another agent already took', () => {
    const first = add('First', { priority: 0 });
    const second = add('Second', { priority: 1 });

    assert.equal(claimNext(db, 'alice')?.ref, first.ref);
    assert.equal(claimNext(db, 'bob')?.ref, second.ref);
    assert.equal(claimNext(db, 'carol'), null);
  });

  test('release puts work back and clears the assignee', () => {
    const task = add('Work');
    claimTask(db, task.id, 'alice');
    const released = releaseTask(db, task.id, 'alice');

    assert.equal(released.assignee, null);
    assert.equal(released.status, 'ready');
    assert.deepEqual(refs(readyTasks(db)), [task.ref]);
  });
});

describe('dependencies', () => {
  test('rejects self-dependency and cycles', () => {
    const a = add('A');
    const b = add('B', { dependsOn: [a.ref] });

    assert.throws(() => addDep(db, a.id, a.id, 'blocks'), /cannot depend on itself/);
    assert.throws(() => addDep(db, a.id, b.id, 'blocks'), /cycle/);
  });

  test('rejects indirect cycles', () => {
    const a = add('A');
    const b = add('B', { dependsOn: [a.ref] });
    const c = add('C', { dependsOn: [b.ref] });

    assert.throws(() => addDep(db, a.id, c.id, 'blocks'), /cycle/);
  });

  test('tracks both directions of the edge', () => {
    const blocker = add('Blocker');
    const dependent = add('Dependent', { dependsOn: [blocker.ref] });

    assert.deepEqual(requireTask(db, dependent.ref).blocked_by, [blocker.ref]);
    assert.deepEqual(requireTask(db, blocker.ref).blocks, [dependent.ref]);
  });
});

describe('recurrence', () => {
  test('closing a recurring task materialises the next occurrence', () => {
    const weekly = add('Weekly review', { recur: '0 9 * * 1', tags: ['ops'] });
    const { recurrence } = setStatus(db, weekly.id, 'done', 'test');

    assert.ok(recurrence, 'a follow-up task should be created');
    assert.equal(recurrence.title, 'Weekly review');
    assert.deepEqual(recurrence.tags, ['ops']);
    assert.equal(recurrence.recurs_from, weekly.id);
    assert.equal(recurrence.due_at, nextCronFire('0 9 * * 1').toISOString());
  });

  test('the new occurrence stays out of the queue until it is due', () => {
    const weekly = add('Weekly review', { recur: '0 9 * * 1' });
    setStatus(db, weekly.id, 'done', 'test');
    assert.deepEqual(readyTasks(db), [], 'a future occurrence is not claimable yet');
  });

  test('recurrence fires once, not on every re-close', () => {
    const weekly = add('Weekly review', { recur: '0 9 * * 1' });
    setStatus(db, weekly.id, 'done', 'test');
    setStatus(db, weekly.id, 'done', 'test');
    setStatus(db, weekly.id, 'ready', 'test');
    setStatus(db, weekly.id, 'done', 'test');

    assert.equal(listTasks(db, { includeClosed: true }).length, 2);
  });

  test('non-recurring tasks produce no follow-up', () => {
    const task = add('One-off');
    assert.equal(setStatus(db, task.id, 'done', 'test').recurrence, null);
  });
});

describe('comments and history', () => {
  test('records author and kind so agent progress is distinguishable', () => {
    const task = add('Work');
    addComment(db, task.id, 'alice', 'parser skeleton done', 'progress');
    addComment(db, task.id, 'saarim', 'looks right', 'note');

    const comments = listComments(db, task.id);
    assert.deepEqual(
      comments.map((c) => [c.author, c.kind]),
      [
        ['alice', 'progress'],
        ['saarim', 'note'],
      ],
    );
    assert.equal(requireTask(db, task.ref).comment_count, 2);
  });

  test('rejects empty comments', () => {
    const task = add('Work');
    assert.throws(() => addComment(db, task.id, 'alice', '   '), /needs a body/);
  });
});

describe('waiting on a human', () => {
  test('asking parks the task, drops the lease, and pulls it off the queue', () => {
    const task = add('Ambiguous work');
    claimTask(db, task.id, 'alice');

    const { task: parked } = askForInput(db, task.id, 'alice', 'Postgres or SQLite?');

    assert.equal(parked.status, 'needs_input');
    assert.equal(parked.assignee, null, 'the lease is released so it is not counted in flight');
    assert.equal(parked.lease_expires_at, null);
    assert.equal(parked.question, 'Postgres or SQLite?');
    assert.equal(parked.question_from, 'alice');
    assert.deepEqual(readyTasks(db), [], 'an unanswered question is not claimable');
  });

  test('no agent can claim a task that is waiting on a human', () => {
    const task = add('Ambiguous work');
    askForInput(db, task.id, 'alice', 'Which one?');

    assert.equal(claimTask(db, task.id, 'bob'), null);
    assert.equal(claimNext(db, 'bob'), null);
  });

  test('answering returns it to the queue with the reply in the thread', () => {
    const task = add('Ambiguous work');
    askForInput(db, task.id, 'alice', 'Postgres or SQLite?');

    const { task: answered } = answerInput(db, task.id, 'saarim', 'SQLite.');

    assert.equal(answered.status, 'ready');
    assert.equal(answered.question, null, 'the question stops being outstanding');
    assert.deepEqual(refs(readyTasks(db)), [task.ref]);
    assert.deepEqual(
      listComments(db, task.id).map((c) => [c.kind, c.author, c.body]),
      [
        ['question', 'alice', 'Postgres or SQLite?'],
        ['answer', 'saarim', 'SQLite.'],
      ],
    );
  });

  test('the question history survives, it is just no longer pending', () => {
    const task = add('Ambiguous work');
    askForInput(db, task.id, 'alice', 'Which one?');
    answerInput(db, task.id, 'saarim', 'This one.');

    assert.equal(requireTask(db, task.ref).question, null);
    assert.equal(listComments(db, task.id).length, 2);
  });

  test('a second round of question and answer works', () => {
    const task = add('Ambiguous work');
    askForInput(db, task.id, 'alice', 'First?');
    answerInput(db, task.id, 'saarim', 'Yes.');
    askForInput(db, task.id, 'bob', 'Second?');

    const pending = requireTask(db, task.ref);
    assert.equal(pending.question, 'Second?', 'the newest question is the pending one');
    assert.equal(pending.question_from, 'bob');
  });

  test('awaitingInput is the human inbox', () => {
    const asked = add('Needs a decision');
    add('Ordinary work');
    askForInput(db, asked.id, 'alice', 'Which approach?');

    assert.deepEqual(refs(awaitingInput(db)), [asked.ref]);
  });

  test('a parked task still blocks its dependents', () => {
    const blocker = add('Blocker');
    const dependent = add('Dependent', { dependsOn: [blocker.ref] });
    askForInput(db, blocker.id, 'alice', 'Which way?');

    assert.deepEqual(requireTask(db, dependent.ref).blocked_by, [blocker.ref]);
    assert.deepEqual(readyTasks(db), []);
  });

  test('you cannot ask a question on a closed task', () => {
    const task = add('Finished');
    setStatus(db, task.id, 'done', 'test');

    assert.throws(() => askForInput(db, task.id, 'alice', 'Too late?'), /already done/);
  });

  test('empty questions and answers are rejected', () => {
    const task = add('Work');
    assert.throws(() => askForInput(db, task.id, 'alice', '  '), /What do you need to know/);
    askForInput(db, task.id, 'alice', 'Real question?');
    assert.throws(() => answerInput(db, task.id, 'saarim', ''), /needs a body/);
  });

  test('answering a task that was not asking just leaves a comment', () => {
    const task = add('Work');
    const { task: after } = answerInput(db, task.id, 'saarim', 'FYI');

    assert.equal(after.status, 'backlog', 'status is untouched when nothing was pending');
    assert.equal(listComments(db, task.id).length, 1);
  });
});

describe('digest', () => {
  test('separates overdue from due-today and reports stale leases', () => {
    const overdue = add('Overdue', { dueAt: new Date(Date.now() - 86_400_000) });
    const later = add('Later today', { dueAt: new Date(Date.now() + 60_000) });
    const abandoned = add('Abandoned');
    claimTask(db, abandoned.id, 'ghost', -1_000);

    const report = digest(db);
    assert.deepEqual(refs(report.overdue), [overdue.ref]);
    assert.deepEqual(refs(report.due_today), [later.ref]);
    assert.deepEqual(refs(report.stale_leases), [abandoned.ref]);
  });
});

describe('transactions', () => {
  test('a failed nested transaction rolls back the whole outer operation', () => {
    assert.throws(() => {
      tx(db, () => {
        add('Outer');
        tx(db, () => {
          add('Inner');
          throw new Error('boom');
        });
      });
    }, /boom/);

    assert.equal(listTasks(db, { includeClosed: true }).length, 0);
  });
});

describe('errors are actionable', () => {
  test('an unknown project lists the valid keys', () => {
    assert.throws(
      () => createTask(db, { title: 'x', project: 'nope', actor: 'test' }),
      /Existing projects: demo/,
    );
  });

  test('an unknown ref explains the format', () => {
    assert.throws(() => requireTask(db, 'demo-999'), /orchestration ls/);
  });

  test('an out-of-range priority names the range', () => {
    assert.throws(() => add('x', { priority: 9 }), /Priority must be 0-3/);
  });
});

describe('time parsing', () => {
  test('durations', () => {
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('3d'), 259_200_000);
    assert.equal(parseDuration('1w'), 604_800_000);
    assert.equal(parseDuration('friday'), null);
  });

  test('natural language resolves forward', () => {
    const from = new Date('2026-08-05T12:00:00.000Z');
    assert.ok(parseWhen('friday', from)!.getTime() > from.getTime());
    assert.ok(parseWhen('in 2 weeks', from)!.getTime() > from.getTime());
    assert.equal(parseWhen('not a date at all', from), null);
  });

  test('cron rejects nonsense with guidance', () => {
    assert.throws(() => nextCronFire('every monday'), /5 fields/);
  });
});

describe('AGENTS.md merge', () => {
  test('replaces the managed block instead of appending a second copy', () => {
    const once = mergeAgentsFile('# Project\n\nSome notes.\n');
    const twice = mergeAgentsFile(once);

    assert.equal(twice.match(/orchestration:begin/g)?.length, 1);
    assert.ok(twice.startsWith('# Project\n\nSome notes.\n'));
  });
});

describe('writes report what actually landed', () => {
  // An agent that trusts a confirmation it cannot verify is worse than one that
  // gets an error: it reports success and moves on. Every write returns the row
  // as re-read after the transaction, so a caller can print that rather than a
  // hardcoded literal describing what was merely intended.
  test('ask returns the re-read row, and long or awkward text survives it', () => {
    const db = fresh();

    const cases: [string, string][] = [
      ['short', 'Cookies or JWT?'],
      ['long', 'Should we use session cookies or JWT? '.repeat(3000)],
      ['newlines', 'line one\nline two\n\nline four?'],
      ['non-ascii', 'Use JWT — not cookies… ≥2 refresh tokens'],
    ];

    for (const [label, question] of cases) {
      const task = createTask(db, { title: `ask-${label}`, project: 'demo', actor: 'test' });
      const { task: updated, comment } = askForInput(db, task.id, 'agent', question);

      assert.equal(updated.status, 'needs_input', `${label}: status must be re-read as parked`);
      assert.equal(updated.assignee, null, `${label}: the lease must be released`);
      // `.trim()` is the only transformation a question is subject to; nothing
      // is truncated, including six-figure character counts.
      assert.equal(
        comment.body,
        question.trim(),
        `${label}: the question must persist without truncation`,
      );
      assert.equal(
        requireTask(db, task.ref).status,
        updated.status,
        `${label}: the returned row must match a fresh read`,
      );
    }
  });
});
