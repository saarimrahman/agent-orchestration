import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOrchestration } from 'orchestration';
import * as core from 'orchestration/core';

describe('programmatic SDK', () => {
  test('drives the queue lifecycle by task ref', () => {
    const client = openOrchestration({ databasePath: ':memory:', actor: 'sdk-agent' });
    client.createProject('demo', 'Demo');

    const blocker = client.createTask({ title: 'Run validation', project: 'demo' });
    const audit = client.createTask({
      title: 'Audit validation results',
      project: 'demo',
      dependsOn: [blocker.ref],
      tags: ['validation'],
    });

    assert.deepEqual(client.ready().map((task) => task.ref), [blocker.ref]);
    client.setTaskStatus(blocker.ref, 'done');
    assert.equal(client.claimTask(audit.ref)?.assignee, 'sdk-agent');

    client.addComment(audit.ref, 'Validation is still running.', 'progress');
    const snoozed = client.snoozeTask(audit.ref, new Date(Date.now() + 60_000));
    assert.equal(snoozed.status, 'ready');
    assert.equal(snoozed.assignee, null);
    assert.equal(client.ready().some((task) => task.ref === audit.ref), false);
    assert.throws(
      // @ts-expect-error Snoozing is a lifecycle operation, not a field update.
      () => client.updateTask(audit.ref, { snoozeUntil: null }),
      /Use snoozeTask/,
    );

    assert.equal(client.comments(audit.ref)[0]?.author, 'sdk-agent');

    client.close();
    client.close();
    assert.throws(() => client.ready(), /client is closed/);
  });

  test('supports the handoff and resume workflow', () => {
    using client = openOrchestration({ databasePath: ':memory:', actor: 'sdk-agent' });
    client.createProject('demo');
    const task = client.createTask({ title: 'Choose an API shape', project: 'demo' });
    client.claimTask(task.ref);

    const asked = client.askForInput(task.ref, 'Class or factory?');
    assert.equal(asked.task.status, 'needs_input');
    assert.equal(asked.task.assignee, null);
    assert.deepEqual(client.inbox().map((item) => item.ref), [task.ref]);

    const answered = client.answerInput(task.ref, 'Use a factory.');
    assert.equal(answered.task.status, 'ready');
    assert.equal(client.claimNext()?.ref, task.ref);
  });

  test('publishes the advanced core as a supported subpath', () => {
    assert.equal(typeof core.openDb, 'function');
    assert.equal(typeof core.claimTask, 'function');
  });

  test('can resolve a workspace database without changing process cwd', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orchestration-sdk-'));
    const configDir = join(workspace, '.orchestration');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ db: './queue.db' }));

    try {
      const first = openOrchestration({ cwd: workspace, actor: 'sdk-agent' });
      first.createProject('demo');
      first.close();

      using second = openOrchestration({ cwd: workspace, actor: 'sdk-agent' });
      assert.deepEqual(second.projects().map((project) => project.key), ['demo']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
