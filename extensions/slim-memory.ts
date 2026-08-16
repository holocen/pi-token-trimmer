// slim-memory.ts
//
// Slim, command-based cross-session memory for Pi — a lightweight alternative
// to the heavy pi-memory package (which registers 7 tools and costs ~1,700
// tokens/turn in schema).
//
// Design goals:
//   - ZERO per-turn tool schemas. This registers commands only, no LLM-callable
//     tools, so it adds nothing to the per-turn prompt overhead.
//   - Memory is persisted to a plain markdown file: ~/.pi/agent/slim-memory.md
//   - On every agent turn, the saved memory is injected into the system prompt
//     (via before_agent_start), so it's always available to the model without
//     needing a memory tool call.
//
// Commands (interactive only; not sent to the model as tools):
//   /mem add <text>     Append a note to persistent memory
//   /mem show           Show current memory (and path)
//   /mem clear          Clear all memory
//   /mem import <file>  Import notes from a file (e.g. a notes.md)
//   /mem fork <name>    Tag a decision point for later revisit (#fork <name>)
//   /mem decision <text> Log a one-line decision with a "why"
//   /mem restore <name> Show the context around a #fork tag
//   /mem forks          List all fork tags
//
// Env config:
//   SLIM_MEMORY_FILE   override the memory file path
//   SLIM_MEMORY_MAX    max chars injected into system prompt per turn (default 4000)
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MEMORY_FILE = process.env.SLIM_MEMORY_FILE || join(homedir(), ".pi", "agent", "slim-memory.md");
const MAX_INJECT = parseInt(process.env.SLIM_MEMORY_MAX ?? "4000", 10);

async function readMemory(): Promise<string> {
  try {
    return await readFile(MEMORY_FILE, "utf8");
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  // Inject memory into the system prompt each turn so it's always in context.
  pi.on("before_agent_start", async (event) => {
    const mem = await readMemory();
    if (!mem.trim()) return;
    // Keep the NEWEST entries (tail), since /mem add and /mem decision append.
    // Truncating the head would silently drop the most recent decisions.
    const trimmed = mem.length > MAX_INJECT ? mem.slice(-MAX_INJECT) + "\n... [memory truncated — older entries dropped]" : mem;
    const injection = `\n\n## Persistent Memory (slim-memory)\n${trimmed}\n`;
    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // Command: /mem
  pi.registerCommand("mem", {
    description: "Slim cross-session memory: add/show/clear/import notes",
    handler: async (args, ctx) => {
      const parts = (args || "").split(/\s+/);
      const sub = (parts[0] || "show").toLowerCase();
      const rest = parts.slice(1).join(" ").trim();

      switch (sub) {
        case "add": {
          if (!rest) {
            ctx.ui.notify("Usage: /mem add <text>", "info");
            return;
          }
          try {
            await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
            await appendFile(MEMORY_FILE, `- ${rest}\n`, "utf8");
            ctx.ui.notify(`Memory saved. (${MEMORY_FILE})`, "info");
          } catch (e) {
            ctx.ui.notify(`Failed to save memory: ${(e as Error).message}`, "error");
          }
          return;
        }
        case "clear": {
          try {
            await writeFile(MEMORY_FILE, "", "utf8");
            ctx.ui.notify("Memory cleared.", "info");
          } catch (e) {
            ctx.ui.notify(`Failed to clear: ${(e as Error).message}`, "error");
          }
          return;
        }
        case "import": {
          if (!rest) {
            ctx.ui.notify("Usage: /mem import <filepath>", "info");
            return;
          }
          try {
            const content = await readFile(rest, "utf8");
            await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
            await appendFile(MEMORY_FILE, `\n${content}\n`, "utf8");
            ctx.ui.notify(`Imported ${content.length} chars into memory.`, "info");
          } catch (e) {
            ctx.ui.notify(`Import failed: ${(e as Error).message}`, "error");
          }
          return;
        }
        case "show":
        case "list":
        default: {
          const mem = await readMemory();
          if (!mem.trim()) {
            ctx.ui.notify(`Memory is empty. Add notes with /mem add <text>. File: ${MEMORY_FILE}`, "info");
          } else {
            ctx.ui.notify(`Memory (${MEMORY_FILE}):\n\n${mem}`, "info");
          }
          return;
        }
        case "fork": {
          // Tag a decision point: /mem fork <name>
          if (!rest) {
            ctx.ui.notify("Usage: /mem fork <name>  (tags a decision point for later revisit)", "info");
            return;
          }
          try {
            await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
            const stamp = new Date().toISOString().slice(0, 10);
            await appendFile(MEMORY_FILE, `\n## #fork ${rest} (${stamp})\n- decision: \n- why: \n`, "utf8");
            ctx.ui.notify(`Fork "${rest}" created. Add context with /mem decision or edit the memory file.`, "info");
          } catch (e) {
            ctx.ui.notify(`Failed to create fork: ${(e as Error).message}`, "error");
          }
          return;
        }
        case "decision": {
          // Log a one-line decision with a why: /mem decision <text>
          if (!rest) {
            ctx.ui.notify("Usage: /mem decision <what + why>", "info");
            return;
          }
          try {
            await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
            const stamp = new Date().toISOString().slice(0, 10);
            await appendFile(MEMORY_FILE, `- [${stamp}] DECISION: ${rest}\n`, "utf8");
            ctx.ui.notify(`Decision logged.`, "info");
          } catch (e) {
            ctx.ui.notify(`Failed to log decision: ${(e as Error).message}`, "error");
          }
          return;
        }
        case "restore": {
          // Show the section around a fork: /mem restore <name>
          const name = rest.toLowerCase();
          if (!name) {
            ctx.ui.notify("Usage: /mem restore <fork-name>", "info");
            return;
          }
          const mem = await readMemory();
          const idx = mem.toLowerCase().indexOf(`#fork ${name}`);
          if (idx === -1) {
            ctx.ui.notify(`No fork "${rest}" found. Use /mem forks to list them.`, "info");
          } else {
            const section = mem.slice(idx, idx + 600);
            ctx.ui.notify(`Fork "${rest}":\n${section}`, "info");
          }
          return;
        }
        case "forks": {
          const mem = await readMemory();
          const forks = mem.split("\n").filter((l) => /#fork /i.test(l));
          if (forks.length === 0) {
            ctx.ui.notify("No forks yet. Create one with /mem fork <name>", "info");
          } else {
            ctx.ui.notify(`Forks (${forks.length}):\n${forks.join("\n")}`, "info");
          }
          return;
        }
      }
    },
  });
}
