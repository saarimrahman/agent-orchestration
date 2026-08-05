/**
 * The single source of the agent-facing workflow text. `orch instructions`, the
 * generated Claude Code skill, and the AGENTS.md block all render from here, so
 * they cannot drift apart.
 */

export const WORKFLOW = `## Task queue (\`orch\`)

Shared to-do list for this project. You pick work off it, report progress to it,
and close items on it. Every read command takes \`--json\`.

### The loop

1. \`orch next --claim --agent <your-name>\` — takes the highest-priority
   unblocked task and marks it in progress. Prints nothing and exits 1 when the
   queue is empty. Claiming is atomic, so several agents can poll at once.
2. \`orch show <ref>\` — read the full body, dependencies, and comment history
   before you start.
3. \`orch comment <ref> --progress "<what you just did>"\` — at each real
   milestone, not every step. This is how a human watching the board knows where
   you are.
4. \`orch done <ref> "<what changed>"\` — on completion. The closing note is
   required reading for whoever picks up the follow-up.

### When you cannot finish

- Blocked on other work: \`orch add "<the blocker>"\` then
  \`orch dep add <ref> <blocker-ref>\` and \`orch release <ref>\`. The task leaves
  the queue until the blocker closes, then returns on its own.
- Needs a decision from a human: \`orch comment <ref> "<the question>"\` and
  \`orch release <ref>\`.
- Not actionable yet: \`orch snooze <ref> 3d\`. It disappears and comes back.

Always \`release\` what you cannot finish. A held task is invisible to every
other agent until its lease expires.

### Adding work

\`\`\`
orch add "Title" -p <project> -P1 --due friday --tag api --dep <blocker-ref>
\`\`\`

Priority is 0-3, 0 highest, 2 default. \`--due\` accepts \`friday\`,
\`tomorrow 9am\`, \`3d\`, or \`2026-08-12\`. \`--recur "0 9 * * 1"\` makes it repeat:
closing it creates the next occurrence automatically.

### Reading the board

- \`orch ready --json\` — what is claimable right now
- \`orch ls --json\` — everything open, with filters (\`--status\`, \`--tag\`,
  \`--project\`, \`--assignee\`, \`--due today\`)
- \`orch digest --json\` — overdue, due today, ready, in progress, and abandoned
  leases in one payload. Use this when you are triaging rather than executing.

### Rules

- Never edit the database directly. Use the CLI.
- One task at a time. Close or release before claiming the next.
- Do not close a task you did not verify. If tests did not run, say so in the
  closing note.
`;

export function skillFile(): string {
  return `---
name: orch
description: >-
  Read, claim, and update tasks on the local orch queue. Use when asked to pick
  up pending work, report progress on a task, check what is overdue or ready, or
  add a to-do. Also use before starting work that a queued task already covers.
---

${WORKFLOW}`;
}

export function agentsBlock(): string {
  return `<!-- orch:begin -->
${WORKFLOW}<!-- orch:end -->
`;
}

const BEGIN = '<!-- orch:begin -->';
const END = '<!-- orch:end -->';

/** Insert or replace the orch block in an existing AGENTS.md without touching the rest. */
export function mergeAgentsFile(existing: string): string {
  const block = agentsBlock();
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);

  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length + 1);
  }
  const separator = existing.length && !existing.endsWith('\n\n') ? '\n\n' : '';
  return existing + separator + block;
}
