<!-- orchestration:begin -->
## Task queue (`orchestration`)

Shared to-do list for this project. You pick work off it, report progress to it,
and close items on it. Every read command takes `--json`.

### The loop

1. `orchestration next --claim --agent <your-name>` — takes the highest-priority
   unblocked task and marks it in progress. Prints nothing and exits 1 when the
   queue is empty. Claiming is atomic, so several agents can poll at once.
2. `orchestration show <ref>` — read the full body, dependencies, and comment history
   before you start.
3. `orchestration comment <ref> --progress "<what you just did>"` — at each real
   milestone, not every step. This is how a human watching the board knows where
   you are.
4. `orchestration done <ref> "<what changed>"` — on completion. The closing note is
   required reading for whoever picks up the follow-up.

### When you cannot finish

- **Needs a decision only a human can make**: `orchestration ask <ref> "<question>"`.
  This is the important one. It parks the task in `needs_input`, releases your
  lease, and puts it in front of the human on the board. Do not guess at a
  product decision, an ambiguous spec, or anything destructive — ask.
  Ask one specific question with the options you see, not "what should I do?".
- Blocked on other work: `orchestration add "<the blocker>"` then
  `orchestration dep add <ref> <blocker-ref>` and `orchestration release <ref>`. The task leaves
  the queue until the blocker closes, then returns on its own.
- Not actionable yet: `orchestration snooze <ref> 3d`. It disappears and comes back.

Always `ask` or `release` what you cannot finish. A held task is invisible to
every other agent until its lease expires.

A task in `needs_input` is off the queue, so `orchestration next` will never hand you
a question you cannot answer. Once a human runs `orchestration answer`, it returns to
the queue with their reply in the thread — read the comments before restarting.

### Adding work

```
orchestration add "Title" -p <project> -P1 --due friday --tag api --dep <blocker-ref>
```

Priority is 0-3, 0 highest, 2 default. `--due` accepts `friday`,
`tomorrow 9am`, `3d`, or `2026-08-12`. `--recur "0 9 * * 1"` makes it repeat:
closing it creates the next occurrence automatically.

### Durable memory

`orchestration show <ref>` and `orchestration next --claim` include a small set of active memories
relevant to the task. When you verify a reusable fact, pitfall, decision, or
workflow, preserve it with:

```
orchestration remember "UI tests need a production build first" -p demo \
  --kind pitfall --tag ui --source demo-12 --verified
```

Use `orchestration memory search "<query>" --json` for explicit recall. Use
`--candidate` for an unverified learning; candidates stay out of automatic
task context until `orchestration memory promote <id>`.

Memories are meant to be revised, not just appended to. When one turns out to be
wrong, incomplete, or superseded, correct it in place rather than writing a
second memory that contradicts the first:

```
orchestration memory edit <id> --body "<corrected text>" --verified
orchestration memory edit <id> --title "..." --kind pitfall --tag ui
orchestration memory archive <id>          # wrong or no longer true
orchestration remember "..." --supersedes <id>
```

`orchestration memory edit <id>` with no flags prints the Markdown path so you
can edit the file directly; follow that with `orchestration memory commit`.

Memory is local Markdown under `~/.orchestration/memory` by default, not the
source repository. Do not store secrets.

### Reading the board

- `orchestration ready --json` — what is claimable right now
- `orchestration ls --json` — everything open, with filters (`--status`, `--tag`,
  `--project`, `--assignee`, `--due today`)
- `orchestration ls "<text>" --json` — full-text over title and body. Add
  `--all` to include closed tasks. Search before you add: the queue often
  already has the thing you are about to file.
- `orchestration inbox --json` — everything waiting on a human, with the question
- `orchestration digest --json` — waiting-on-human, overdue, due today, ready, in
  progress, and abandoned leases in one payload. Use this when you are triaging
  rather than executing.

### Rules

- Never edit the database directly. Use the CLI.
- One task at a time. Close or release before claiming the next.
- Do not close a task you did not verify. If tests did not run, say so in the
  closing note.
<!-- orchestration:end -->
