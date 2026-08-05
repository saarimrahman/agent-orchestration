# orch

A local to-do list that coding agents can read, claim, and report progress to —
with a board you can actually look at.

One SQLite file. A CLI for agents. A web UI for you. Nothing runs in the
background, nothing phones home, nothing launches processes on your behalf.

```
agents / you  ──►  orch CLI ──┐
                              ├──►  ~/.orch/orch.db
browser  ──►  orch ui  ───────┘
```

## Why it works this way

Agents **pull**. `orch` is a passive store: it never spawns an agent, never
supervises a process, never opens a worktree. An agent asks for work, takes it,
reports back, and closes it. That single decision is why the whole thing is a
few files instead of a distributed system, and why it composes with whatever you
already use to run agents — Claude Code's `/loop`, Routines, system cron, or you
typing at a terminal.

The design borrows the parts that have proven out elsewhere: the ready-queue and
atomic-claim primitives from [beads](https://github.com/steveyegge/beads), the
generated-agent-instructions idea from
[Backlog.md](https://github.com/MrLesk/Backlog.md), and a deliberately small
command surface, because a large tool catalog measurably degrades how well
models pick the right call.

## Install

Needs Node 22.6+ (it uses the built-in `node:sqlite` and runs TypeScript
directly — no build step for the CLI, no native modules to compile).

```bash
npm install
npm link               # optional: puts `orch` on your PATH
```

Without `npm link`, use `node bin/orch …` or `npm run orch -- …`.

There is no separate build step — `orch ui` builds the board itself the first
time it runs.

## Quick start

```bash
orch init --project demo        # creates the DB, writes agent instructions
orch add "Write the parser" -P1 --due friday
orch add "Ship it" --dep demo-1 # blocked until demo-1 closes
orch ready                      # only demo-1 — demo-2 is blocked
orch ui                         # open the board
```

## The agent loop

This is what `orch init` writes into `AGENTS.md` and a Claude Code skill, so
agents in the repo pick it up without you explaining it each session.

```bash
orch next --claim --agent alice        # take the top unblocked task, atomically
orch show demo-1                       # read the body, deps, and comment history
orch comment demo-1 --progress "parser skeleton done"
orch done demo-1 "landed, tests green"
```

`orch next` exits 1 when the queue is empty, so a polling loop can branch on the
exit code without parsing anything. Every read command takes `--json`.

When an agent can't finish:

```bash
orch ask demo-1 "Cookies or JWT?"  # needs a human decision — see below
orch dep add demo-1 demo-9         # found a blocker
orch release demo-1                # give it back
orch snooze demo-1 3d              # not actionable yet
```

## When an agent needs you

The case that matters most in practice: an agent hits a decision only a human
can make. Guessing at it is worse than stopping.

```bash
orch ask demo-1 "Session cookies or JWT? Mobile needs offline auth."
```

That moves the task to `needs_input`, drops the lease, and takes it off the
queue — so `orch next` will never hand another agent a question it can't answer.
On the board it lands in a **Needs you** column with the question readable on
the card, plus a banner at the top of the board and a count in the sidebar.

You answer from the drawer, or from the terminal:

```bash
orch inbox                                    # everything waiting on you
orch answer demo-1 "JWT. Refresh tokens in a follow-up."
```

The task returns to `ready` with your reply in the thread. It goes back to the
queue rather than to whoever asked, because by the time you reply that agent's
session is usually gone — whichever agent picks it up next reads the answer in
the comments.

`orch digest` leads with this section, so a cron'd triage agent sees blocked
humans before anything else.

## Scheduling

`orch` has no scheduler, because it doesn't need one. Due dates and snoozes are
just fields the ready queue filters on, and closing a recurring task creates its
next occurrence on the spot. Nothing has to be running when a cron fires.

To have an agent actually *act* on due work, point any scheduler at `orch
digest`:

```bash
# inside a Claude Code session
/loop 30m orch digest --json and act on anything overdue

# system crontab, weekdays at 9:03
3 9 * * 1-5  cd ~/code/myproject && claude -p "$(orch digest --json) — triage these"
```

Or use a [Claude Code Routine](https://code.claude.com/docs/en/routines) if you
want it to run with your machine off.

`orch digest` returns overdue, due-today, ready, in-progress, and abandoned
leases in one payload — sized to drop straight into a prompt.

## Commands

| | |
|---|---|
| `orch ready` | Everything claimable right now |
| `orch next [--claim]` | Top of the queue, optionally taken atomically |
| `orch claim <ref>` / `release <ref>` | Lease control |
| `orch digest` | Triage payload: waiting on you, overdue, due today, ready, in progress |
| `orch ask <ref> "<q>"` | Park a task with a question for a human |
| `orch answer <ref> "<a>"` | Answer it and return the task to the queue |
| `orch inbox` | Everything waiting on you |
| `orch add "<title>"` | Create — `-p` project, `-P` priority, `--due`, `--tag`, `--dep`, `--recur` |
| `orch ls` | List — `--status`, `--tag`, `--project`, `--assignee`, `--due today`, `--all` |
| `orch show <ref>` | Detail, comments, and history |
| `orch edit <ref>` | Change any field |
| `orch comment <ref> "<text>"` | Note, or `--progress` for an agent update |
| `orch start\|review\|done\|cancel <ref> ["note"]` | Status transitions |
| `orch snooze <ref> <when>` | Defer |
| `orch dep add\|rm <ref> <blocker>` | Dependency graph |
| `orch tag add\|rm <ref> <tag>` / `orch tags` | Tags |
| `orch project add\|ls\|archive <key>` | Projects |
| `orch feed` | Recent activity across all tasks |
| `orch ui [--port 4477]` | Open the board |
| `orch instructions` | Print the agent workflow |
| `orch where` | Print the database path |

Times accept durations (`3d`, `2h`, `30m`), dates (`2026-08-12`), or plain
English (`friday`, `tomorrow 9am`, `in two weeks`).

## How the queue works

**Ready** means all of: status is `backlog` or `ready`; every blocking
dependency is closed; any snooze has elapsed; and nobody holds it. There is no
`blocked` status — blocked is derived from the dependency graph, so a status
field can never disagree with reality.

`needs_input` *is* a real status, unlike `blocked`. Nothing can derive the fact
that an agent is stuck on a human judgement call — the agent has to assert it.

**Claiming is atomic.** The entire ready predicate lives in the claim's `WHERE`
clause, so when several agents poll at once, exactly one wins and the rest see a
clean failure. `orch next --claim` walks down the queue rather than failing when
it loses a race.

**Leases expire** (default 60m, `--ttl`). A crashed agent's task returns to the
queue instead of being stranded, and shows up in `orch digest` under abandoned
leases.

**Recurrence** is materialized on close. Finishing a task with `--recur` creates
the next occurrence, snoozed until its due date, with `recurs_from` pointing
back at the one you closed — so the history survives.

## The board

`orch ui` serves on `127.0.0.1` only. Kanban columns with drag-and-drop, a
detail drawer with a comment thread where agent progress, questions, and
answers are each badged distinctly, saved views (needs you, due today,
overdue, ready, snoozed), and a global activity feed of what every agent has
been doing.

It updates live from writes made by *any* process, so a CLI command in another
terminal moves the board within a second — the server watches the append-only
event log rather than its own in-process state.

### Working on the UI

```bash
npm run dev
```

That starts the API server and the Vite dev server together and prints both
URLs — open the first one (`http://127.0.0.1:4478`) for hot reload. Ctrl-C stops
both. Override ports with `ORCH_PORT` and `ORCH_WEB_PORT`.

**If the board looks blank**, you are almost certainly pointed at a port with
nothing on it. `orch ui` serves on **4477**; `npm run dev` serves the hot-reload
board on **4478** and only that one has Vite behind it. Check the terminal for
`Port … already in use` — a stale server from an earlier run will take the port
and make the new one exit.

## Where the data lives

`~/.orch/orch.db` by default — global on purpose, since agents report into it
from many repos. Override with `$ORCH_DB`, or with a `.orch/config.json`
(`{"db": "./orch.db"}`) anywhere up the tree from where you run the command.

`$ORCH_PROJECT` sets the default project when you omit `-p`. `$ORCH_ACTOR` sets
who you are in the activity log when you omit `--agent`.

## Tests

```bash
npm test        # 49 tests: queue semantics, claim contention, recurrence, API, UI render
npm run typecheck
```

The suite covers the parts that are subtly wrong if untested: ready-queue
filtering, concurrent claims on one task, lease expiry and reclaim, dependency
cycles, recurrence firing exactly once, and the full ask/answer handoff. The UI
test bundles the real app and renders it against a real server in jsdom, which
catches render crashes without needing a browser.

## Not included

No agent spawning, worktrees, or log capture. No MCP server — the CLI covers the
same ground at zero context cost, and the core layer is a thin wrapper away if
that changes. No auth, no multi-user, no sync.
