// token-saver-report.ts
//
// RTK-style token savings extension for Pi.
//
// TWO MODES:
//   report mode (default, TK_ACTIVE unset/0):  READ-ONLY. Measures how many
//     input tokens built-in tools (read/grep/find/ls) and bash are returning
//     into context, and estimates how many an RTK-style compact rewrite would
//     save. Never rewrites or blocks anything.
//   active mode (TK_ACTIVE=1):                  REWRITES. Compacts the output
//     of read/grep/find/ls results before they enter context, cutting input
//     tokens. Bash commands are left untouched (rewriting arbitrary shell is
//     risky); use the built-in tools to benefit.
//
// Token estimate uses chars / 4 (same approximation as RTK). The compression
// ratios are heuristic and approximate.
//
// Commands:
//   /tk-save       Show the savings report (works in both modes).
//   /tk-mode       Show current mode.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isBashToolResult,
} from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
const ACTIVE = process.env.TK_ACTIVE === "1" || process.env.TK_ACTIVE === "true";

// Configurable compaction thresholds (env vars, defaults match original behavior).
// Dial these down (keep more content) for critical implementation work where the
// model needs full context; crank up for cheap exploration.
const TK_READ_HEAD = parseInt(process.env.TK_READ_HEAD ?? "50", 10); // head lines kept per read
const TK_READ_SIG = parseInt(process.env.TK_READ_SIG ?? "60", 10); // signature lines per read
const TK_GREP_PER_FILE = parseInt(process.env.TK_GREP_PER_FILE ?? "15", 10); // matches per file
const TK_GREP_LINE_LEN = parseInt(process.env.TK_GREP_LINE_LEN ?? "160", 10); // max line length
const TK_LS_MAX = parseInt(process.env.TK_LS_MAX ?? "40", 10); // entries kept per ls

// Per-command-type compression ratio for bash (report-only estimation).
const BASH_RULES: { test: RegExp; ratio: number; minChars: number }[] = [
  { test: /^(ls|tree|find)\b/, ratio: 0.12, minChars: 80 },
  { test: /^(cat|read|head|tail|bat|type)\s/, ratio: 0.1, minChars: 120 },
  { test: /^(grep|rg|ack|ag)\b/, ratio: 0.25, minChars: 80 },
  { test: /^git status\b/, ratio: 0.08, minChars: 60 },
  { test: /^git diff\b/, ratio: 0.3, minChars: 100 },
  { test: /^git log\b/, ratio: 0.15, minChars: 40 },
  { test: /^git (add|commit|push|pull)\b/, ratio: 0.05, minChars: 20 },
  { test: /(npm test|cargo test|pytest|go test|ruff check)\b/, ratio: 0.15, minChars: 80 },
  { test: /^docker ps\b/, ratio: 0.4, minChars: 60 },
];

// Compression ratio for built-in tools (report-only estimation).
const BUILTIN_RATIOS: Record<string, { ratio: number; minChars: number }> = {
  read: { ratio: 0.1, minChars: 120 },
  grep: { ratio: 0.25, minChars: 80 },
  find: { ratio: 0.4, minChars: 60 },
  ls: { ratio: 0.12, minChars: 80 },
};

interface Sample {
  command: string;
  outputChars: number;
  outputTokens: number;
  savedTokens: number;
  savedPct: number;
}

interface State {
  samples: Sample[];
  totalOutputTokens: number;
  totalSavedTokens: number;
  byCommand: Map<string, { calls: number; savedTokens: number; outputTokens: number }>;
}

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

function splitSegments(command: string): string[] {
  return command
    .split(/\s*(?:;|&&|\|\||\||\n)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Report-mode: estimate compressed chars for a tool result.
function estimateCompressedChars(command: string, outputChars: number, toolName?: string): number | null {
  if (toolName && toolName !== "bash") {
    const rule = BUILTIN_RATIOS[toolName];
    if (rule) return Math.max(rule.minChars, outputChars * rule.ratio);
    return null;
  }
  const segments = splitSegments(command);
  if (segments.length === 0) return null;
  let keptFraction = 0;
  let matched = 0;
  for (const seg of segments) {
    const rule = BASH_RULES.find((r) => r.test.test(seg));
    if (rule) {
      keptFraction += rule.ratio;
      matched += 1;
    } else {
      keptFraction += 1;
    }
  }
  if (matched === 0) return null;
  const avgRatio = keptFraction / segments.length;
  const minChars = Math.max(20, outputChars * 0.05);
  return Math.max(minChars, outputChars * avgRatio);
}

// ---------- ACTIVE MODE: compact built-in tool results ----------

// Compact a `read` result: keep the head (first N lines), then list
// likely-signature lines from the remainder, capped, with a truncation marker.
function compactRead(text: string, maxHeadLines = TK_READ_HEAD, maxSigLines = TK_READ_SIG): string {
  const lines = text.split("\n");
  if (lines.length <= maxHeadLines + 8) return text; // small file: leave as-is

  const head = lines.slice(0, maxHeadLines);
  const rest = lines.slice(maxHeadLines);
  // Heuristic signature detection: lines that look like definitions/declarations.
  const sigPattern = /(^\s*(?:public|private|protected|export|async|const|let|function|def|class|struct|impl|fn|interface|type|enum|case|static|func|var|val|fun|using|namespace|package|import|from)\b)|[{(]\s*$/;
  const sigs: string[] = [];
  for (let i = 0; i < rest.length && sigs.length < maxSigLines; i++) {
    const line = rest[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("<!--")) continue;
    if (sigPattern.test(line) && line.length <= 200) {
      sigs.push(line.trimEnd());
    }
  }

  const out: string[] = [];
  out.push(`# read: ${lines.length} lines total. Showing head (${maxHeadLines}) + signatures:`);
  out.push(...head.map((l) => l.replace(/\s+$/, "")));
  if (sigs.length > 0) {
    out.push(`# --- signatures in lines ${maxHeadLines + 1}..${lines.length} ---`);
    out.push(...sigs);
  }
  const skipped = lines.length - maxHeadLines - sigs.length;
  out.push(`# ... [truncated: ${skipped} lines not shown. Use read with offset/limit for specific sections]`);
  return out.join("\n");
}

// Compact a `grep` result: group by file, count matches per file, truncate long lines.
function compactGrep(text: string, maxPerFile = TK_GREP_PER_FILE, maxLineLen = TK_GREP_LINE_LEN): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return text;

  // Group by leading file:path segment if present (grep output like "file:line: text").
  const groups = new Map<string, string[]>();
  let ungrouped: string[] = [];
  const fileRe = /^([^\s:]+):\d+:/;
  for (const line of lines) {
    const m = line.match(fileRe);
    if (m) {
      const file = m[1];
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file)!.push(line);
    } else {
      ungrouped.push(line);
    }
  }

  const out: string[] = [];
  if (groups.size > 0) {
    for (const [file, matches] of groups) {
      const shown = matches.slice(0, maxPerFile).map((l) => (l.length > maxLineLen ? l.slice(0, maxLineLen) + "…" : l));
      out.push(`## ${file} (${matches.length} matches)`);
      out.push(...shown.map((l) => "  " + l));
      if (matches.length > maxPerFile) out.push(`  ... +${matches.length - maxPerFile} more in ${file}`);
    }
  } else {
    // No file:line structure; just truncate and cap.
    const capped = lines.slice(0, maxPerFile * 3).map((l) => (l.length > maxLineLen ? l.slice(0, maxLineLen) + "…" : l));
    out.push(...capped);
    if (lines.length > maxPerFile * 3) out.push(`... +${lines.length - maxPerFile * 3} more matches`);
  }
  if (ungrouped.length > 0) out.push(...ungrouped.slice(0, 5));
  return out.join("\n");
}

// Compact a `find` result: group by directory with counts.
function compactFind(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length <= 20) return text;
  const byDir = new Map<string, number>();
  for (const line of lines) {
    const idx = line.lastIndexOf("/");
    const dir = idx > 0 ? line.slice(0, idx) : ".";
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const out: string[] = [`# find: ${lines.length} results grouped by directory`];
  const sorted = [...byDir.entries()].sort((a, b) => b[1] - a[1]);
  for (const [dir, count] of sorted) out.push(`  ${dir || "."}  (${count})`);
  out.push(`# [truncated: list individual paths with 'find' + tighter pattern if needed]`);
  return out.join("\n");
}

// Compact an `ls` result: group into dirs / files / other with counts, cap listing.
function compactLs(text: string, maxEntries = TK_LS_MAX): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  // Skip a leading "total N" line.
  const body = lines.filter((l) => !/^total\s+\d+$/.test(l));
  if (body.length <= maxEntries) return text;

  const dirs: string[] = [];
  const files: string[] = [];
  const other: string[] = [];
  // Simple heuristic: entries ending in "/" are dirs.
  for (const line of body) {
    const name = line.split(/\s+/).pop() ?? line;
    if (name.endsWith("/")) dirs.push(name);
    else if (/^[.-]+$/.test(name)) other.push(name);
    else files.push(name);
  }
  const out: string[] = [`# ls: ${body.length} entries. Dirs: ${dirs.length}, files: ${files.length}`];
  if (dirs.length) out.push(`Dirs: ${dirs.slice(0, 20).join(", ")}${dirs.length > 20 ? ", …" : ""}`);
  if (files.length) out.push(`Files: ${files.slice(0, maxEntries).join(", ")}${files.length > maxEntries ? ", …" : ""}`);
  out.push(`# [truncated. Use ls <dir> to drill in]`);
  return out.join("\n");
}

// Active-mode dispatcher: returns compact text or null to leave unchanged.
function activeCompact(toolName: string, text: string): string | null {
  switch (toolName) {
    case "read":
      return compactRead(text);
    case "grep":
      return compactGrep(text);
    case "find":
      return compactFind(text);
    case "ls":
      return compactLs(text);
    default:
      return null;
  }
}

export default function (pi: ExtensionAPI) {
  const state: State = {
    samples: [],
    totalOutputTokens: 0,
    totalSavedTokens: 0,
    byCommand: new Map(),
  };

  function updateFooter(ctx: { ui: { setWidget: (k: string, l: string[]) => void } }) {
    if (state.totalOutputTokens <= 0) return;
    if (typeof (ctx.ui as { setWidget?: unknown }).setWidget !== "function") return;
    const pct = (state.totalSavedTokens / state.totalOutputTokens) * 100;
    const mode = ACTIVE ? "ACTIVE" : "report";
    ctx.ui.setWidget("tk-save", [`[${mode}] ${state.totalSavedTokens.toLocaleString()} tok saved (${pct.toFixed(0)}% of ${state.totalOutputTokens.toLocaleString()})`]);
  }

  pi.on("tool_result", (event, ctx) => {
    // Determine which tool this is and the token it produced.
    let toolName: string;
    let commandForRule: string;
    if (isBashToolResult(event)) {
      toolName = "bash";
      commandForRule = typeof event.input?.command === "string" ? event.input.command : "";
    } else if (isReadToolResult(event)) {
      toolName = "read";
      commandForRule = "read";
    } else if (isGrepToolResult(event)) {
      toolName = "grep";
      commandForRule = "grep";
    } else if (isFindToolResult(event)) {
      toolName = "find";
      commandForRule = "find";
    } else if (isLsToolResult(event)) {
      toolName = "ls";
      commandForRule = "ls";
    } else {
      return;
    }

    const originalText = textOfContent(event.content);
    const outputChars = originalText.length;
    if (outputChars <= 0) return;

    const outputTokens = Math.max(1, Math.round(outputChars / CHARS_PER_TOKEN));
    const compressedChars = estimateCompressedChars(commandForRule, outputChars, toolName);
    const savedTokens = compressedChars === null ? 0 : Math.max(0, outputTokens - Math.round(compressedChars / CHARS_PER_TOKEN));
    const savedPct = outputTokens > 0 ? (savedTokens / outputTokens) * 100 : 0;

    state.samples.push({ command: commandForRule, outputChars, outputTokens, savedTokens, savedPct });
    state.totalOutputTokens += outputTokens;
    state.totalSavedTokens += savedTokens;

    const key = toolName === "bash" ? commandForRule.split(" ").slice(0, 3).join(" ") || "bash" : toolName;
    const agg = state.byCommand.get(key) ?? { calls: 0, savedTokens: 0, outputTokens: 0 };
    agg.calls += 1;
    agg.savedTokens += savedTokens;
    agg.outputTokens += outputTokens;
    state.byCommand.set(key, agg);

    updateFooter(ctx);

    // ACTIVE mode: compact built-in tool results by RETURNING a content patch
    // (mutating event.content does not affect the final result).
    if (ACTIVE && toolName !== "bash") {
      const compact = activeCompact(toolName, originalText);
      if (compact && compact !== originalText) {
        return { content: [{ type: "text", text: compact }] };
      }
    }
  });

  // /tk-mode: show the current mode.
  pi.registerCommand("tk-mode", {
    description: "Show token-saver mode (report vs active)",
    handler: async (_args, ctx) => {
      const mode = ACTIVE ? "ACTIVE (rewrites read/grep/find/ls results)" : "report (read-only)";
      ctx.ui.notify(`Token saver: ${mode}. Set TK_ACTIVE=1 and /reload to enable active mode.`, "info");
    },
  });

  // /tk-status: show the ACTIVE compaction thresholds (so current config is
  // visible, not just the defaults).
  pi.registerCommand("tk-status", {
    description: "Show active token-saver compaction thresholds",
    handler: async (_args, ctx) => {
      const mode = ACTIVE ? "ACTIVE" : "report (read-only)";
      const lines = [
        `mode: ${mode}`,
        `TK_ACTIVE=${ACTIVE ? "1" : "0"}`,
        `TK_READ_HEAD=${TK_READ_HEAD} (head lines kept per read)`,
        `TK_READ_SIG=${TK_READ_SIG} (signature lines per read)`,
        `TK_GREP_PER_FILE=${TK_GREP_PER_FILE} (matches per file)`,
        `TK_GREP_LINE_LEN=${TK_GREP_LINE_LEN} (max line length)`,
        `TK_LS_MAX=${TK_LS_MAX} (entries kept per ls)`,
      ];
      ctx.ui.notify(`Token-saver settings:\n\n${lines.join("\n")}`, "info");
    },
  });

  // /tk-save: full report.
  pi.registerCommand("tk-save", {
    description: "Show RTK-style token savings report",
    handler: async (_args, ctx) => {
      if (state.samples.length === 0) {
        ctx.ui.notify("No tool output measured yet.", "info");
        return;
      }
      const lines: string[] = [];
      lines.push(`Mode: ${ACTIVE ? "ACTIVE (rewriting)" : "report (read-only)"}`);
      lines.push(`Output tokens measured: ${state.totalOutputTokens.toLocaleString()}`);
      lines.push(`Estimated tokens saved: ${state.totalSavedTokens.toLocaleString()}`);
      lines.push(`Overall reduction: ${((state.totalSavedTokens / state.totalOutputTokens) * 100).toFixed(1)}%`);
      lines.push("");
      lines.push("By command prefix:");
      const sorted = [...state.byCommand.entries()].sort((a, b) => b[1].savedTokens - a[1].savedTokens);
      for (const [cmd, agg] of sorted) {
        const pct = agg.outputTokens > 0 ? (agg.savedTokens / agg.outputTokens) * 100 : 0;
        lines.push(`  ${cmd}  x${agg.calls}  saved ${agg.savedTokens.toLocaleString()} tok (${pct.toFixed(0)}%)`);
      }
      lines.push("");
      lines.push(ACTIVE ? "Active mode: read/grep/find/ls outputs were compacted in context." : "Read-only: no outputs were rewritten.");
      lines.push("Estimates use chars/4.");

      if (ctx.hasUI) {
        const result = await ctx.ui.custom?.({ title: "Token Savings (RTK-style)", content: lines.join("\n") });
        if (result === undefined) ctx.ui.notify(lines.join("\n"), "info");
      } else {
        process.stderr.write(lines.join("\n") + "\n");
      }
    },
  });
}
