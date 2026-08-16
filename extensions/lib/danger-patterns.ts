// danger-patterns.ts
//
// SHARED danger-pattern detection for tool-execution guards.
//
// Single source of truth for the "destructive command" regex used by:
//   - bash-approval-guard.ts (non-interactive bash blocking)
//   - slim-bg-task.ts       (bg_task start refusal)
//
// Having one module here means tuning the patterns once applies to BOTH tools —
// they cannot silently drift into different security postures.

// Destructive / sensitive patterns:
//   - recursive rm (-rf / -fr / -r)  — plain `rm <file>` is NOT flagged
//   - sudo, chmod, mkfs, dd          — system-level destructive ops
//   - git push / reset --hard / clean -f
//   - .env and .git/ path access (escaped so `.env` doesn't match "frontend")
// Plain `>` redirects are intentionally NOT flagged (too common; the permission
// system still gates file writes).
const DANGER = /(^|[\s;])(rm\s+-[a-z]*r[a-z]*|sudo|chmod|mkfs\.|dd|git\s+(push|reset\s+--hard|clean\s+-f))\b|(^|[\s;])\.env\b|(^|[\s;\/])\.git\//;

/** True if the command contains a destructive/sensitive pattern. */
export function isDangerousCommand(command: string): boolean {
  return DANGER.test(command);
}
