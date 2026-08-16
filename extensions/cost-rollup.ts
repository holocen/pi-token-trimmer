// cost-rollup.ts
//
// #2: Per-turn + session cost rollup in the footer widget.
//
// Watches the end of each agent turn, reads the actual provider-reported usage
// cost (not an estimate), and shows a live footer widget:
//
//   [cost] this turn: $0.0123 | session: $0.4567
//
// Session cost is re-derived from session entries each turn so it stays accurate
// across model switches, compactions, and tool/nested usage.
//
// Read-only. No behavior change to the agent.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function entryCost(entry: SessionEntry): { cost: number; tokens: number; key: string } {
  let usage: { cost?: { total?: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  let key = "unknown";

  if (entry.type === "message" && entry.message?.role === "assistant") {
    usage = entry.message.usage;
    key = `${entry.message.provider ?? "?"}/${entry.message.responseModel ?? entry.message.model ?? "?"}`;
  } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
    usage = entry.message.usage;
    key = "tools";
  } else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: unknown }).usage) {
    usage = (entry as { usage?: { cost?: { total?: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    key = "summaries";
  }

  if (!usage) return { cost: 0, tokens: 0, key };
  const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return { cost: usage.cost?.total ?? 0, tokens, key };
}

export default function (pi: ExtensionAPI) {
  // Last turn's cost, shown between turns.
  let lastTurnCost = 0;

  function render(ctx: { ui: { setWidget: (k: string, l: string[]) => void } }) {
    if (typeof (ctx.ui as { setWidget?: unknown }).setWidget !== "function") return;

    // Re-derive session totals from actual session entries (authoritative).
    let sessionCost = 0;
    let sessionTokens = 0;
    const byModel = new Map<string, { cost: number; tokens: number }>();
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const { cost, tokens, key } = entryCost(entry);
        sessionCost += cost;
        sessionTokens += tokens;
        const m = byModel.get(key) ?? { cost: 0, tokens: 0 };
        m.cost += cost;
        m.tokens += tokens;
        byModel.set(key, m);
      }
    } catch {
      // ignore; fall back to last known values
    }

    // Only show buckets that actually have cost or tokens (drops the empty
    // "unknown" bucket and other zero-usage entries from the display).
    const top = [...byModel.entries()]
      .filter(([, v]) => v.cost > 0 || v.tokens > 0)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 2);
    const modelLine =
      top.length > 0 ? top.map(([k, v]) => `${k} $${v.cost.toFixed(4)}`).join("  ") : "no usage yet";

    ctx.ui.setWidget("tk-cost", [
      `this turn $${lastTurnCost.toFixed(4)} | session $${sessionCost.toFixed(4)}`,
      `tokens ${sessionTokens.toLocaleString()} | ${modelLine}`,
    ]);
  }

  pi.on("turn_end", (event, ctx) => {
    lastTurnCost = 0;
    // event.message is the assistant message; sum toolResult usage too.
    const msg = (event as unknown as { message?: { usage?: { cost?: { total?: number } } } }).message;
    lastTurnCost = msg?.usage?.cost?.total ?? 0;
    const toolResults = (event as unknown as { toolResults?: Array<{ usage?: { cost?: { total?: number } } }> }).toolResults ?? [];
    for (const tr of toolResults) lastTurnCost += tr.usage?.cost?.total ?? 0;
    render(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    lastTurnCost = 0;
    render(ctx);
  });

  pi.on("model_select", (_event, ctx) => render(ctx));
  pi.on("session_compact", (_event, ctx) => render(ctx));
}
