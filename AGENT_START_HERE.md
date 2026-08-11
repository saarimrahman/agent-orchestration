# Agent start here

This guide is for coding agents working in this repository. Read it before
changing code or documentation. The human-facing product guide is in
[README.md](README.md); the exact queue contract is in [AGENTS.md](AGENTS.md).

## What orchestration is for

`orchestration` is a shared, durable work queue. It lets agents and humans see
what is ready, who owns it, what changed, what is blocked, and where a human
decision is needed.

It is deliberately passive. The CLI stores and reports work; it does not spawn
agents, run commands, create worktrees, or supervise processes. Use your agent
runner's subagent tools for parallel work and use `orchestration` to coordinate
the durable task lifecycle.

## Start with the right task

Use `--json` on every read command.

If you were asked to take the next available task:

```bash
orchestration next --claim --agent <your-name> --json
```

If a user gave you a specific task, do not claim an unrelated item from the
top of the queue. Search first, then claim the matching task. If it does not
exist, add it and claim the returned reference:

```bash
orchestration ls "search terms" --all --json
orchestration add "Clear outcome" -p <project> -P1 --tag <tag>
orchestration claim <ref> --agent <your-name>
```

Always read the complete task before working:

```bash
orchestration show <ref> --json
```

One agent owns one queued task at a time. Finish, ask, or release it before
claiming another.

## Work in an iterative loop

1. Inspect the task, relevant memory, repository state, and existing tests.
2. Decide on the smallest useful next checkpoint.
3. Delegate independent, bounded investigations or implementations to
   subagents when they can run in parallel.
4. Implement one coherent increment and verify it.
5. Report real milestones to the task:

   ```bash
   orchestration comment <ref> --progress "What is now true"
   ```

6. Re-read new evidence, adjust, and repeat until the outcome is genuinely
   complete.

Do not stop at a plan, the first plausible patch, or a passing narrow test.
Inspect the diff, run proportionate verification, and check the requested
behavior end to end.

### Using subagents well

Spawn subagents when there are at least two separable workstreams, such as
codebase reconnaissance and test analysis, or independent implementation
areas. Give each subagent a precise scope, expected output, and relevant paths.

The parent agent remains responsible for the claimed queue item, integrates
the results, resolves conflicts, and performs final verification. Subagents
share the workspace, so avoid assigning overlapping edits. They should not
claim the parent's queue task; create distinct queued tasks only when the work
is genuinely independent and should have its own lifecycle.

For tiny or strictly sequential work, stay local. Delegation has coordination
cost and should create real parallel progress.

## Make assumptions, and know when to ask

Make a reasonable assumption and keep moving when the choice is local,
reversible, consistent with existing patterns, and unlikely to change the
product outcome. State important assumptions in the progress note or closing
summary.

Ask for human help when the answer changes product behavior, requires missing
authority or credentials, risks destructive or external effects, or leaves
multiple materially different valid outcomes:

```bash
orchestration ask <ref> "One specific question, with the options and tradeoff"
```

This moves the task to `needs_input` and releases the lease. Do not guess at a
product decision, and do not leave an unfinished task silently held.

If another piece of work is the blocker, represent that relationship and give
the current task back:

```bash
orchestration add "Concrete blocker" -p <project>
orchestration dep add <ref> <blocker-ref>
orchestration release <ref>
```

Use `orchestration snooze <ref> 3d` only when the work is not actionable until
a known time.

## Finish cleanly

Before closing a task:

- inspect the final diff and repository status;
- run the relevant tests, type checks, or manual verification;
- make sure subagent findings are integrated rather than merely reported;
- record reusable facts or pitfalls with `orchestration remember`;
- create follow-up tasks for real out-of-scope work, searching first to avoid
  duplicates.

Then close with an evidence-based note:

```bash
orchestration done <ref> "What changed; verification run; any explicit limits"
```

Never claim tests passed when they did not run. If verification was limited,
say exactly what was and was not checked.

## Useful views

```bash
orchestration ready --json
orchestration digest --json
orchestration inbox --json
orchestration ls --status in_progress --json
orchestration memory search "relevant topic" --json
```

See [README.md](README.md#commands) for the complete command reference and
[AGENTS.md](AGENTS.md) for the rules that take precedence during queue work.
