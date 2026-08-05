<!-- orch:begin -->
## Task queue (`orch`)

Shared to-do list for this project. You pick work off it, report progress to it,
and close items on it. Every read command takes `--json`.

### The loop

1. `orch next --claim --agent <your-name>` — takes the highest-priority
   unblocked task and marks it in progress. Prints nothing and exits 1 when the
   queue is empty. Claiming is atomic, so several agents can poll at once.
2. `orch show <ref>` — read the full body, dependencies, and comment history
   before you start.
3. `orch comment <ref> --progress "<what you just did>"` — at each real
   milestone, not every step. This is how a human watching the board knows where
   you are.
4. `orch done <ref> "<what changed>"` — on completion. The closing note is
   required reading for whoever picks up the follow-up.

### When you cannot finish

- Blocked on other work: `orch add "<the blocker>"` then
  `orch dep add <ref> <blocker-ref>` and `orch release <ref>`. The task leaves
  the queue until the blocker closes, then returns on its own.
- Needs a decision from a human: `orch comment <ref> "<the question>"` and
  `orch release <ref>`.
- Not actionable yet: `orch snooze <ref> 3d`. It disappears and comes back.

Always `release` what you cannot finish. A held task is invisible to every
other agent until its lease expires.

### Adding work

```
orch add "Title" -p <project> -P1 --due friday --tag api --dep <blocker-ref>
```

Priority is 0-3, 0 highest, 2 default. `--due` accepts `friday`,
`tomorrow 9am`, `3d`, or `2026-08-12`. `--recur "0 9 * * 1"` makes it repeat:
closing it creates the next occurrence automatically.

### Reading the board

- `orch ready --json` — what is claimable right now
- `orch ls --json` — everything open, with filters (`--status`, `--tag`,
  `--project`, `--assignee`, `--due today`)
- `orch digest --json` — overdue, due today, ready, in progress, and abandoned
  leases in one payload. Use this when you are triaging rather than executing.

### Rules

- Never edit the database directly. Use the CLI.
- One task at a time. Close or release before claiming the next.
- Do not close a task you did not verify. If tests did not run, say so in the
  closing note.
<!-- orch:end -->
