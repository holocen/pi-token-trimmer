// bash-approval-guard.ts
//
// #3: Bash-approval queue + permission logger.
//
// Solves the "15-minute hang" you hit when a bash command needs approval but no
// interactive UI is available (e.g. -p / --mode json / --mode rpc). Instead of
// sitting and waiting forever, this extension:
//
//   - Logs every approval request + decision to ~/.pi/agent/bash-approvals.jsonl
//   - In NON-interactive modes (print/json/rpc), where a prompt can never be
//     answered, it refuses the command immediately with a clear reason instead
//     of blocking, so the run cannot hang.
//
//   - (Optional) In interactive mode, it can queue bash commands for you to
//     approve instead of pausing the agent. Interactive approval is left to the
//     built-in flow by default (disabled) since it risks deadlock; you can turn
//     it on with BASH_QUEUE_INTERACTIVE=1.
//
// Read-only for approved commands — it only intercepts the *blocking* path.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { isDangerousCommand } from "./lib/danger-patterns";

const LOG_FILE = join(homedir(), ".pi", "agent", "bash-approvals.jsonl");
const QUEUE_INTERACTIVE = process.env.BASH_QUEUE_INTERACTIVE === "1";

async function logDecision(cmd: string, mode: string, decision: string, reason?: string): Promise<void> {
  try {
    await appendFile(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), command: cmd, mode, decision, reason }) + "\n",
      "utf8"
    );
  } catch {
    // best-effort
  }
}

export default function (pi: ExtensionAPI) {
  // Non-interactive modes have no prompt available. Intercept and refuse
  // genuinely destructive commands rather than blocking indefinitely.
  // Patterns come from the shared danger-patterns module (see isDangerousCommand).

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const cmd = event.input.command ?? "";
    if (typeof cmd !== "string" || cmd.trim() === "") return;

    const nonInteractive = ctx.mode !== "tui";
    const risky = isDangerousCommand(cmd);

    if (nonInteractive && risky) {
      void logDecision(cmd, ctx.mode, "refused", "non-interactive + risky");
      // Block immediately with a clear reason instead of hanging.
      return { block: true, reason: `[bash-approval-guard] Refused in ${ctx.mode} mode (no approval UI available). Command: ${cmd.slice(0, 120)}` };
    }

    if (nonInteractive) {
      // Non-risky command in non-interactive mode: allow but log.
      void logDecision(cmd, ctx.mode, "allowed");
    } else if (QUEUE_INTERACTIVE && risky) {
      // Interactive + queue mode: log that it reached the approval gate.
      void logDecision(cmd, ctx.mode, "awaiting-approval");
      // Let the built-in interactive approval flow handle it (do not block here).
    }
  });

  pi.registerCommand("tk-bashlog", {
    description: "Show bash-approval log path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Bash approval log: ${LOG_FILE}`, "info");
    },
  });
}
