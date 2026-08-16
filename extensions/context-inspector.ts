// context-inspector.ts
//
// #9: Context health inspector.
//
// A /ctx command that shows what's actually occupying your context window:
//   - Current context usage (tokens + % of window) via ctx.getContextUsage()
//   - Breakdown of session entries by type (user / assistant / toolResult / compaction)
//   - Estimated tokens each old tool result still occupies in context
//   - Size of the system prompt / active tools (best-effort)
//   - Cost attributed by model (reuses the same aggregation as cost-rollup)
//
// Read-only. It only inspects and reports; it never modifies the session.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function textLen(content: unknown): number {
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") n += (b as { text: string }).text.length;
    return n;
  }
  if (typeof content === "string") return content.length;
  return 0;
}

function entryInfo(entry: SessionEntry): { kind: string; chars: number; cost: number; model: string } {
  let kind = entry.type;
  let chars = 0;
  let cost = 0;
  let model = "";
  if (entry.type === "message") {
    const m = entry.message as {
      role?: string;
      content?: unknown;
      model?: string;
      provider?: string;
      responseModel?: string;
      usage?: { cost?: { total?: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    kind = m.role ?? "message";
    chars = textLen(m.content);
    cost = m.usage?.cost?.total ?? 0;
    model = m.responseModel ?? m.model ?? "";
  } else if ((entry.type === "branch_summary" || entry.type === "compaction") && "usage" in entry) {
    const u = (entry as { usage?: { cost?: { total?: number } } }).usage;
    cost = u?.cost?.total ?? 0;
  }
  return { kind, chars, cost, model };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ctx", {
    description: "Inspect what occupies the context window",
    handler: async (_args, ctx) => {
      const out: string[] = [];

      // 1. Current context usage.
      let usageTokens: number | null = null;
      let ctxWindow = 0;
      try {
        const cu = ctx.getContextUsage();
        usageTokens = cu?.tokens ?? null;
        ctxWindow = cu?.contextWindow ?? 0;
      } catch {
        // ignore
      }
      if (usageTokens != null && ctxWindow > 0) {
        const pct = ((usageTokens / ctxWindow) * 100).toFixed(1);
        out.push(`Context: ${usageTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pct}%)`);
      } else if (usageTokens != null) {
        out.push(`Context: ${usageTokens.toLocaleString()} tokens`);
      } else {
        out.push("Context: unknown (no LLM response yet)");
      }

      // 2. System prompt + active model size (best-effort).
      try {
        const sp = ctx.getSystemPrompt?.();
        if (sp) out.push(`System prompt: ~${sp.length.toLocaleString()} chars (~${Math.round(sp.length / 4).toLocaleString()} tok)`);
      } catch {
        // ignore
      }
      out.push(`Active model: ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`);

      // 3. Session entries by type + total cost + biggest tool results.
      const byType = new Map<string, { count: number; chars: number; cost: number }>();
      let sessionCost = 0;
      let bigToolResults: { kind: string; chars: number; model: string }[] = [];
      try {
        for (const entry of ctx.sessionManager.getEntries()) {
          const { kind, chars, cost, model } = entryInfo(entry);
          const t = byType.get(kind) ?? { count: 0, chars: 0, cost: 0 };
          t.count += 1;
          t.chars += chars;
          t.cost += cost;
          byType.set(kind, t);
          sessionCost += cost;
          if (kind === "toolResult" && chars > 0) bigToolResults.push({ kind, chars, model });
        }
      } catch {
        // ignore
      }

      out.push("");
      out.push("Entries by type:");
      const sortedTypes = [...byType.entries()].sort((a, b) => b[1].chars - a[1].chars);
      for (const [kind, t] of sortedTypes) {
        out.push(`  ${kind}: x${t.count}  ~${(t.chars / 4).toLocaleString(undefined, { maximumFractionDigits: 0 })} tok${t.cost ? `  $${t.cost.toFixed(4)}` : ""}`);
      }

      out.push("");
      out.push(`Session cost (provider-reported): $${sessionCost.toFixed(4)}`);

      if (bigToolResults.length > 0) {
        bigToolResults.sort((a, b) => b.chars - a.chars);
        out.push("");
        out.push(`Largest tool results still in context (top ${Math.min(5, bigToolResults.length)}):`);
        for (const r of bigToolResults.slice(0, 5)) {
          out.push(`  ~${Math.round(r.chars / 4).toLocaleString()} tok  (${r.model || "?"})`);
        }
        out.push("Tip: use /compact to summarize older tool output; start /new for unrelated tasks.");
      }

      if (ctx.hasUI) {
        const result = await ctx.ui.custom?.({ title: "Context Health", content: out.join("\n") });
        if (result === undefined) ctx.ui.notify(out.join("\n"), "info");
      } else {
        process.stderr.write(out.join("\n") + "\n");
      }
    },
  });
}
