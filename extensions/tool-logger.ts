// tool-logger.ts
//
// Combo extension: (1) tool-call logger, (2) model-info status widget.
//
//  1) Tool-call logger: appends a JSON line to ~/.pi/agent/tool-log.jsonl for
//     every bash/read/grep/find/ls tool execution, capturing tool, args, output
//     size, estimated tokens, estimated cost, and the active model. Read-only;
//     does not modify any tool result.
//  2) Model widget: shows the active provider/model in the status bar, updated
//     on model_select.
//
// Token estimate uses chars / 4 (approximate). Cost is estimated from the
// active model's cost metadata when available; otherwise 0. This is for
// attribution, not exact billing.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isBashToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CHARS_PER_TOKEN = 4;
const LOG_FILE = join(homedir(), ".pi", "agent", "tool-log.jsonl");

// Track the active model so tool entries carry the model that ran them.
let activeProvider = "unknown";
let activeModel = "unknown";

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
      out += (block as { text: string }).text + "\n";
    }
  }
  return out;
}

interface ToolRecord {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  outputChars: number;
  outputTokens: number;
  isError: boolean;
  modelProvider: string;
  modelId: string;
  estCostUsd: number;
  wasteFlags?: string[];
}

function jsonSafe(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (k === "command" || k === "path" || k === "pattern" || k === "glob" || k === "offset" || k === "limit" || k === "exclude" || k === "base" || k === "tool" || k === "verbatim") {
        o[k] = jsonSafe((v as Record<string, unknown>)[k]);
      }
    }
    return o;
  }
  return null;
}

async function logTool(record: ToolRecord): Promise<void> {
  try {
    await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Best-effort; never block tool execution on a logging failure.
  }
}

// ---- Wasteful-pattern detection ----
// Track read targets within a session to catch re-reads, and flag commands that
// dump large output or use broad scans. This turns the cost log into automatic
// bad-behavior detection.
const LARGE_OUTPUT_TOKENS = 2000;
const readTargets = new Map<string, { firstTs: string; count: number }>();
const readCounts = new Map<string, number>(); // normalized path -> total reads

function normalizeReadPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  // Normalize to a stable key: lowercase, strip trailing slashes.
  return raw.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") || null;
}

// Detect wasteful patterns for a completed tool result. Returns flags array.
function detectWaste(tool: string, args: Record<string, unknown>, outputTokens: number, command?: string): string[] {
  const flags: string[] = [];

  if (outputTokens >= LARGE_OUTPUT_TOKENS) {
    flags.push(`large-output:${outputTokens}tok`);
  }

  if (tool === "bash" && command) {
    // Broad/recursive scans that dump lots of output.
    if (/(find\s+\/|ls\s+-R|cat\s+[^|\n]+\s*\|?\s*(wc|head|tail)\s*$|find\s+\.\s+-type\s+f.*-name\s+\*)/.test(command)) {
      flags.push("broad-scan");
    }
  }

  if (tool === "read") {
    const path = normalizeReadPath(args.path);
    if (path) {
      const n = readCounts.get(path) ?? 0;
      readCounts.set(path, n + 1);
      if (n + 1 >= 3) {
        flags.push(`re-read:${n + 1}x`);
      }
    }
  }

  return flags;
}


export default function (pi: ExtensionAPI) {
  // ---- (2) model-info widget ----
  const updateStatus = (ctx: { ui: { setStatus: (k: string, v: string) => void } }) => {
    try {
      ctx.ui.setStatus("model", `${activeProvider}/${activeModel}`);
    } catch {
      // no-op if status API unavailable
    }
  };

  pi.on("model_select", (event, ctx) => {
    activeProvider = event.model?.provider ?? "unknown";
    activeModel = event.model?.id ?? "unknown";
    updateStatus(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    // Reflect the model set at startup (model_select may fire before session_start).
    activeProvider = ctx.model?.provider ?? activeProvider;
    activeModel = ctx.model?.id ?? activeModel;
    updateStatus(ctx);
  });

  // ---- (1) tool-call logger ----
  // Log the tool name + args when a tool starts.
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event)) {
      const rec: ToolRecord = {
        ts: new Date().toISOString(),
        tool: "bash",
        args: { command: event.input.command ?? "" },
        outputChars: 0,
        outputTokens: 0,
        isError: false,
        modelProvider: activeProvider,
        modelId: activeModel,
        estCostUsd: 0,
      };
      void logTool(rec);
    }
  });

  // Log output size + estimated cost when a tool completes.
  pi.on("tool_result", (event, ctx) => {
    let tool: string;
    let args: Record<string, unknown> = {};
    let content: unknown = event.content;

    if (isBashToolResult(event)) {
      tool = "bash";
      args = { command: typeof event.input?.command === "string" ? event.input.command : "" };
    } else if (isReadToolResult(event)) {
      tool = "read";
      args = jsonSafe(event.input) as Record<string, unknown>;
    } else if (isGrepToolResult(event)) {
      tool = "grep";
      args = jsonSafe(event.input) as Record<string, unknown>;
    } else if (isFindToolResult(event)) {
      tool = "find";
      args = jsonSafe(event.input) as Record<string, unknown>;
    } else if (isLsToolResult(event)) {
      tool = "ls";
      args = jsonSafe(event.input) as Record<string, unknown>;
    } else {
      return;
    }

    const outputChars = textOfContent(content).length;
    const outputTokens = Math.max(0, Math.round(outputChars / CHARS_PER_TOKEN));

    // Estimated input cost from the active model's cost metadata (per 1M tokens).
    let inputPerM = 0;
    try {
      inputPerM = ctx.model?.cost?.input ?? 0;
    } catch {
      inputPerM = 0;
    }
    const estCostUsd = (outputTokens / 1_000_000) * inputPerM;

    // Detect wasteful patterns.
    const commandStr = tool === "bash" ? (typeof args.command === "string" ? args.command : undefined) : undefined;
    const wasteFlags = detectWaste(tool, args, outputTokens, commandStr);

    const rec: ToolRecord = {
      ts: new Date().toISOString(),
      tool,
      args,
      outputChars,
      outputTokens,
      isError: !!event.isError,
      modelProvider: activeProvider,
      modelId: activeModel,
      estCostUsd,
      wasteFlags: wasteFlags.length > 0 ? wasteFlags : undefined,
    };
    void logTool(rec);
  });

  // Command to show the log path.
  pi.registerCommand("tk-log", {
    description: "Show the tool-call log path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Tool log: ${LOG_FILE}`, "info");
    },
  });

  // /tk-waste: list all waste-flagged tool entries from the log.
  pi.registerCommand("tk-waste", {
    description: "List waste-flagged tool calls (re-reads, broad scans, large output)",
    handler: async (_args, ctx) => {
      const { readFile } = await import("node:fs/promises");
      let raw: string;
      try {
        raw = await readFile(LOG_FILE, "utf8");
      } catch {
        ctx.ui.notify(`No tool log yet at ${LOG_FILE}`, "info");
        return;
      }

      const flagged: { ts: string; tool: string; flags: string[]; tokens: number; desc: string }[] = [];
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        let rec: { ts?: string; tool?: string; wasteFlags?: string[]; outputTokens?: number; args?: Record<string, unknown> };
        try {
          rec = JSON.parse(line) as typeof rec;
        } catch {
          continue;
        }
        if (!rec.wasteFlags || rec.wasteFlags.length === 0) continue;
        const args = rec.args ?? {};
        const desc =
          rec.tool === "bash" && typeof args.command === "string"
            ? args.command.slice(0, 100)
            : (typeof args.path === "string" ? args.path : rec.tool ?? "?");
        flagged.push({
          ts: rec.ts ?? "?",
          tool: rec.tool ?? "?",
          flags: rec.wasteFlags,
          tokens: rec.outputTokens ?? 0,
          desc,
        });
      }

      if (flagged.length === 0) {
        ctx.ui.notify("No waste-flagged tool calls found in the log.", "info");
        return;
      }

      // Aggregate by flag type for a quick summary.
      const byFlag = new Map<string, { count: number; tokens: number }>();
      for (const f of flagged) {
        for (const flag of f.flags) {
          const agg = byFlag.get(flag) ?? { count: 0, tokens: 0 };
          agg.count += 1;
          agg.tokens += f.tokens;
          byFlag.set(flag, agg);
        }
      }

      const out: string[] = [];
      out.push(`Waste-flagged entries: ${flagged.length}`);
      out.push("");
      out.push("By flag:");
      const flagsSorted = [...byFlag.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
      for (const [flag, agg] of flagsSorted) {
        out.push(`  ${flag}: x${agg.count}  ~${agg.tokens.toLocaleString()} tok`);
      }
      out.push("");
      out.push("Entries (newest first):");
      flagged.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      for (const f of flagged.slice(0, 30)) {
        out.push(`  [${f.flags.join(",")}] ${f.tool}: ${f.desc}  (~${f.tokens.toLocaleString()} tok)`);
      }
      if (flagged.length > 30) out.push(`  ... +${flagged.length - 30} more`);

      if (ctx.hasUI) {
        const result = await ctx.ui.custom?.({ title: "Waste-Flagged Tool Calls", content: out.join("\n") });
        if (result === undefined) ctx.ui.notify(out.join("\n"), "info");
      } else {
        process.stderr.write(out.join("\n") + "\n");
      }
    },
  });

  // /tk-cost: aggregate the log by model and by tool.
  pi.registerCommand("tk-cost", {
    description: "Aggregate tool-log cost/tokens by model",
    handler: async (_args, ctx) => {
      const { readFile } = await import("node:fs/promises");
      let raw: string;
      try {
        raw = await readFile(LOG_FILE, "utf8");
      } catch {
        ctx.ui.notify(`No tool log yet at ${LOG_FILE}`, "info");
        return;
      }

      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        ctx.ui.notify(`Tool log is empty: ${LOG_FILE}`, "info");
        return;
      }

      // Aggregate by model key.
      const byModel = new Map<string, { calls: number; outputTokens: number; cost: number; byTool: Map<string, { calls: number; tokens: number }> }>();
      for (const line of lines) {
        let rec: ToolRecord;
        try {
          rec = JSON.parse(line) as ToolRecord;
        } catch {
          continue;
        }
        const key = `${rec.modelProvider}/${rec.modelId}`;
        const m = byModel.get(key) ?? { calls: 0, outputTokens: 0, cost: 0, byTool: new Map() };
        m.calls += 1;
        m.outputTokens += rec.outputTokens || 0;
        m.cost += rec.estCostUsd || 0;
        const t = m.byTool.get(rec.tool) ?? { calls: 0, tokens: 0 };
        t.calls += 1;
        t.tokens += rec.outputTokens || 0;
        m.byTool.set(rec.tool, t);
        byModel.set(key, m);
      }

      const linesOut: string[] = [];
      linesOut.push(`Entries: ${lines.length}`);
      linesOut.push("");

      const sorted = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
      for (const [model, m] of sorted) {
        linesOut.push(`## ${model}`);
        linesOut.push(`  calls: ${m.calls}   output tokens: ${m.outputTokens.toLocaleString()}   est cost: $${m.cost.toFixed(6)}`);
        const tools = [...m.byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
        for (const [tool, t] of tools) {
          linesOut.push(`    ${tool}: x${t.calls}  ${t.tokens.toLocaleString()} tok`);
        }
        linesOut.push("");
      }

      linesOut.push("Note: est cost uses each model's input cost metadata x output tokens (chars/4). Attribution, not billing.");

      if (ctx.hasUI) {
        const result = await ctx.ui.custom?.({
          title: "Tool Log Cost by Model",
          content: linesOut.join("\n"),
        });
        if (result === undefined) ctx.ui.notify(linesOut.join("\n"), "info");
      } else {
        process.stderr.write(linesOut.join("\n") + "\n");
      }
    },
  });
}
