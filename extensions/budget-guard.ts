// budget-guard.ts
//
// #5: Session budget guard.
//
// Tracks estimated session cost against a budget and warns as you approach it.
// Reads the actual provider-reported cost from session entries (same as the
// cost-rollup), then:
//
//   - At `warnAt`% of budget: status-bar warning + one notification.
//   - At `hardAt`% of budget: stronger warning, and (if BUDGET_HARD_STOP=1)
//     suggests compaction or a cheaper model.
//
// Budget is per session by default (SESSION_BUDGET_USD). Optionally set
// DAILY_BUDGET_USD for a rolling daily cap across sessions (resets at midnight
// local; stored in a small state file).
//
// Budgets are configurable via env vars so no settings edit is required:
//   SESSION_BUDGET_USD   e.g. 0.50  (default: no session budget)
//   DAILY_BUDGET_USD     e.g. 2.00  (default: no daily budget)
//   BUDGET_WARN_AT       0.8        (default)
//   BUDGET_HARD_AT       0.95       (default)
//
// Read-only: it only warns; it never blocks the agent.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".pi", "agent", "budget-state.json");

const SESSION_BUDGET = parseFloat(process.env.SESSION_BUDGET_USD ?? "0");
const DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET_USD ?? "0");
const WARN_AT = parseFloat(process.env.BUDGET_WARN_AT ?? "0.8");
const HARD_AT = parseFloat(process.env.BUDGET_HARD_AT ?? "0.95");

function entryCost(entry: SessionEntry): number {
  let usage: { cost?: { total?: number } } | undefined;
  if (entry.type === "message" && entry.message?.role === "assistant") {
    usage = entry.message.usage;
  } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
    usage = entry.message.usage;
  } else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: unknown }).usage) {
    usage = (entry as { usage?: { cost?: { total?: number } } }).usage;
  }
  return usage?.cost?.total ?? 0;
}

export default function (pi: ExtensionAPI) {
  const warned = { session: false, daily: false };
  const hardWarned = { session: false, daily: false };

  async function currentDaily(): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const raw = await readFile(STATE_FILE, "utf8");
      const data = JSON.parse(raw) as { day?: string; cost?: number };
      if (data.day === today) return data.cost ?? 0;
      return 0;
    } catch {
      return 0;
    }
  }

  async function addDaily(delta: number): Promise<void> {
    if (DAILY_BUDGET <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
      const prev = await currentDaily();
      await writeFile(STATE_FILE, JSON.stringify({ day: today, cost: prev + delta }), "utf8");
    } catch {
      // best-effort
    }
  }

  async function check(ctx: { ui: { setStatus: (k: string, v: string) => void; notify: (m: string, t: string) => void } }, sessionCost: number) {
    // Update daily rolling cost from the delta we've tracked this process.
    const dailyCost = await currentDaily();

    const statusParts: string[] = [];
    if (SESSION_BUDGET > 0) {
      const pct = (sessionCost / SESSION_BUDGET) * 100;
      statusParts.push(`session $${sessionCost.toFixed(4)}/${SESSION_BUDGET.toFixed(2)} (${pct.toFixed(0)}%)`);
      if (pct >= HARD_AT * 100 && !hardWarned.session) {
        hardWarned.session = true;
        ctx.ui.notify(`Session budget ${pct.toFixed(0)}% used ($${sessionCost.toFixed(4)}/${SESSION_BUDGET.toFixed(2)}). Consider /compact or switching to a cheaper model.`, "error");
      } else if (pct >= WARN_AT * 100 && !warned.session) {
        warned.session = true;
        ctx.ui.notify(`Session budget at ${pct.toFixed(0)}% ($${sessionCost.toFixed(4)}/${SESSION_BUDGET.toFixed(2)}).`, "info");
      }
    }
    if (DAILY_BUDGET > 0) {
      const pct = (dailyCost / DAILY_BUDGET) * 100;
      statusParts.push(`day $${dailyCost.toFixed(4)}/${DAILY_BUDGET.toFixed(2)} (${pct.toFixed(0)}%)`);
      if (pct >= HARD_AT * 100 && !hardWarned.daily) {
        hardWarned.daily = true;
        ctx.ui.notify(`Daily budget ${pct.toFixed(0)}% used ($${dailyCost.toFixed(4)}/${DAILY_BUDGET.toFixed(2)}).`, "error");
      } else if (pct >= WARN_AT * 100 && !warned.daily) {
        warned.daily = true;
        ctx.ui.notify(`Daily budget at ${pct.toFixed(0)}% ($${dailyCost.toFixed(4)}/${DAILY_BUDGET.toFixed(2)}).`, "info");
      }
    }

    if (statusParts.length > 0) {
      try {
        ctx.ui.setStatus("tk-budget", statusParts.join("  "));
      } catch {
        // no-op
      }
    }
  }

  pi.on("turn_end", async (event, ctx) => {
    if (SESSION_BUDGET <= 0 && DAILY_BUDGET <= 0) return;

    const msg = (event as unknown as { message?: { usage?: { cost?: { total?: number } } } }).message;
    const turnCost = msg?.usage?.cost?.total ?? 0;
    void addDaily(turnCost);

    // Session cost from authoritative session entries.
    let sessionCost = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries()) sessionCost += entryCost(entry);
    } catch {
      sessionCost = 0;
    }
    await check(ctx, sessionCost);
  });

  pi.on("session_start", async (_event, ctx) => {
    let sessionCost = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries()) sessionCost += entryCost(entry);
    } catch {
      sessionCost = 0;
    }
    await check(ctx, sessionCost);
  });

  pi.registerCommand("tk-budget", {
    description: "Show current budget status",
    handler: async (_args, ctx) => {
      let sessionCost = 0;
      try {
        for (const entry of ctx.sessionManager.getEntries()) sessionCost += entryCost(entry);
      } catch {
        sessionCost = 0;
      }
      const daily = await currentDaily();
      const lines = [`Session cost: $${sessionCost.toFixed(4)}`, `Daily cost: $${daily.toFixed(4)}`];
      if (SESSION_BUDGET > 0) lines.push(`Session budget: $${SESSION_BUDGET.toFixed(2)}`);
      if (DAILY_BUDGET > 0) lines.push(`Daily budget: $${DAILY_BUDGET.toFixed(2)}`);
      lines.push("Set SESSION_BUDGET_USD / DAILY_BUDGET_USD to enable thresholds.");
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else process.stderr.write(lines.join("\n") + "\n");
    },
  });
}
