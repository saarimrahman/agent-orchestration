/**
 * The CLI is named `orchestration`; it was `orch` first. Every setting is read
 * under the current name and then the old one, so shells, scripts, and cron
 * entries written against `ORCH_*` keep working without a migration step.
 */
export function envSetting(name: string): string | undefined {
  return process.env[`ORCHESTRATION_${name}`] ?? process.env[`ORCH_${name}`];
}

/**
 * Per-repo config and state directories, current name first. Callers walk these
 * in order and take the first hit, which is what makes an existing `.orch`
 * checkout keep resolving after the rename.
 */
export const CONFIG_DIRS = ['.orchestration', '.orch'] as const;
