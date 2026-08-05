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

- **Needs a decision only a human can make**: `orch ask <ref> "<question>"`.
  This is the important one. It parks the task in `needs_input`, releases your
  lease, and puts it in front of the human on the board. Do not guess at a
  product decision, an ambiguous spec, or anything destructive — ask.
  Ask one specific question with the options you see, not "what should I do?".
- Blocked on other work: `orch add "<the blocker>"` then
  `orch dep add <ref> <blocker-ref>` and `orch release <ref>`. The task leaves
  the queue until the blocker closes, then returns on its own.
- Not actionable yet: `orch snooze <ref> 3d`. It disappears and comes back.

Always `ask` or `release` what you cannot finish. A held task is invisible to
every other agent until its lease expires.

A task in `needs_input` is off the queue, so `orch next` will never hand you
a question you cannot answer. Once a human runs `orch answer`, it returns to
the queue with their reply in the thread — read the comments before restarting.

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
- `orch inbox --json` — everything waiting on a human, with the question
- `orch digest --json` — waiting-on-human, overdue, due today, ready, in
  progress, and abandoned leases in one payload. Use this when you are triaging
  rather than executing.

### Rules

- Never edit the database directly. Use the CLI.
- One task at a time. Close or release before claiming the next.
- Do not close a task you did not verify. If tests did not run, say so in the
  closing note.
<!-- orch:end -->
