---
name: orchestration
description: >-
  Read, claim, and update tasks on the local orchestration queue. Use when asked
  to pick up pending work, report progress on a task, check what is overdue or
  ready, or add a to-do. Also use before starting work that a queued task
  already covers.
---

## Task queue (`orchestration`)

Shared to-do list for this project. You pick work off it, report progress to it,
and close items on it. The CLI is the durable coordination layer; it does not
spawn agents or supervise processes. Every read command takes `--json`.

### Own the outcome

Act as an expert delivery lead. Own the result, not merely the activity. Define
what done means, treat the plan as a hypothesis, and revise it when evidence
changes. Make decisive assumptions when they are local, reversible, consistent
with existing patterns, and unlikely to change the product outcome. Escalate
when a choice changes product behavior, needs missing authority or credentials,
has destructive or external effects, or has multiple materially different valid
answers.

### Work the delivery loop

1. **Observe** — read the full task, dependencies, comments, relevant memories,
   repository state, and existing tests.
2. **Frame** — state the outcome, acceptance evidence, constraints, risks, and
   the smallest useful checkpoint.
3. **Decompose** — separate the critical path from independent work. Keep work
   local when it is tiny or sequential.
4. **Delegate** — when two or more workstreams can progress independently, use
   your agent runner to spawn subagents. Give each a bounded charter: role,
   objective, exact scope or file ownership, expected artifact, acceptance
   criteria, permission boundaries, and evidence to return. Useful roles include
   scout, builder, skeptic, verifier, experimenter, and historian; roles are
   working contracts, not decorative personas. Subagents do not claim the
   parent's queue task.
5. **Execute** — advance the critical path and integrate coherent increments.
   When uncertainty is testable, run a controlled, time-bounded experiment with
   a hypothesis, success signal, fallback, and rollback path.
6. **Synthesize** — reconcile subagent results, resolve conflicts, and inspect
   their actual artifacts. Delegation is not completion; the owning agent keeps
   responsibility for the integrated result.
7. **Verify** — try to falsify the result. Check the diff and requested behavior,
   then run proportionate tests, type checks, or manual checks. Independently
   verify critical claims rather than trusting summaries.
8. **Update** — report a real milestone, then finish, replan, ask, or release.
   Start another delegation wave only when integration exposes new independent
   work, verification finds a gap, or an experiment invalidates an assumption.

Do not stop at a plan, the first plausible patch, or one narrow passing test.

### Claim and report work

If asked to take the next available task:

```
orchestration next --claim --agent <your-name> --json
```

This atomically takes the highest-priority unblocked task and exits 1 when the
queue is empty. If a user gave you a specific task, do not claim an unrelated
item: search for the matching task, add it only if absent, then claim it.

```
orchestration ls "search terms" --all --json
orchestration add "Clear outcome" -p <project> -P1 --tag <tag>
orchestration claim <ref> --agent <your-name>
orchestration show <ref> --json
```

Read the complete task and its comment history before working. One agent owns
one queued task at a time. Report meaningful checkpoints, not every command:

```
orchestration comment <ref> --progress "What is now true"
```

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

Connect related knowledge when the relationship will help retrieval or review:

```
orchestration memory link <source-id> <target-id> --relation supports
orchestration memory backlinks <target-id>
orchestration memory graph <id> --depth 2
orchestration memory lint
```

Use `relates`, `supports`, `contradicts`, `supersedes`, `derived_from`, or
`applies_to`. Search can add `--graph-depth 1` for neighboring memories,
`--explain` for ranking evidence, and `--semantic` when a local embedding
provider has been explicitly configured.

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
- `orchestration ls "<text>" --json` — search refs, titles, bodies, tags, and comments. Add
  `--all` to include closed tasks. Search before you add: the queue often
  already has the thing you are about to file.
- `orchestration inbox --json` — everything waiting on a human, with the question
- `orchestration digest --json` — waiting-on-human, overdue, due today, ready, in
  progress, and abandoned leases in one payload. Use this when you are triaging
  rather than executing.

### Rules

- Never edit the database directly. Use the CLI.
- One task at a time. Close or release before claiming the next.
- Before closing, inspect the final diff and repository status, integrate all
  delegated work, and record reusable verified facts or pitfalls when useful.
- Close with evidence: `orchestration done <ref> "<change; verification; limits>"`.
  Do not close work you did not verify. If checks did not run or were limited,
  say exactly so.
