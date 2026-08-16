// slim-bg-task.ts
//
// Slim background-task tool for Pi — a lighter alternative to pi-background-tasks
// (which registers bg_run, bg_logs, bg_status, bg_kill, bg_delegate, bg_result,
// bg_run_pi_attested, plus fusion_reason/investigate/research/validate — a large
// tool surface).
//
// Design: ONE LLM-callable tool, `bg_task`, with start/status/kill as parameters.
// Spawns detached background processes (via child_process.spawn) for long-running
// shell jobs (test suites, builds, servers) and lets the agent check on them later.
//
// This covers the practical need — "run a long test suite in the background, check
// it later" — at a fraction of the schema cost of the full package. No Fusion /
// multi-model evaluation machinery.
//
// Env config:
//   SLIM_BG_MAX     max concurrent background tasks (default 10)
//   SLIM_BG_LOG     directory for task output logs (default ~/.pi/agent/bg/)
//
// Tool: bg_task
//   action: "start" | "status" | "kill" | "list"
//   command: (start only) the shell command to run in the background
//   id: (status/kill only) the task id
//   Returns: task id / status / output tail
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { isDangerousCommand } from "./lib/danger-patterns";

const MAX_TASKS = parseInt(process.env.SLIM_BG_MAX ?? "10", 10);
const LOG_DIR = process.env.SLIM_BG_LOG || join(homedir(), ".pi", "agent", "bg");

interface BgTask {
  id: string;
  pid: number;
  command: string;
  started: string;
  status: "running" | "done" | "killed" | "error";
  exitCode: number | null;
  logFile: string;
}

const tasks = new Map<string, BgTask>();
const children = new Map<string, ChildProcess>();
let seq = 0;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bg_task",
    label: "Background Task",
    description:
      "Run a long shell command in the background (detached) and check on it later. " +
      'action="start" runs `command` in the background and returns a task id. ' +
      'action="status" with id returns the running/done state and last output. ' +
      'action="kill" with id stops a running task. action="list" shows all tasks.',
    parameters: Type.Object({
      action: Type.Enum({ start: "start", status: "status", kill: "kill", list: "list" } as const),
      command: Type.Optional(Type.String({ description: "Shell command to run (required for start)" })),
      id: Type.Optional(Type.String({ description: "Task id (required for status/kill)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as "start" | "status" | "kill" | "list";

      if (action === "start") {
        const cmd = (params.command as string | undefined) || "";
        if (!cmd.trim()) {
          return { content: [{ type: "text", text: "bg_task start requires a `command`." }], details: {} };
        }
        // SECURITY: block destructive commands here too — otherwise bg_task would
        // bypass bash-approval-guard's danger check (which only sees the "bash"
        // tool). Uses the SHARED danger-patterns module so both guards stay in sync.
        if (isDangerousCommand(cmd)) {
          return {
            content: [{ type: "text", text: `bg_task refused: command contains a destructive pattern. Use the bash tool interactively if this is intended. Command: ${cmd.slice(0, 120)}` }],
            details: {},
          };
        }
        if (tasks.size >= MAX_TASKS) {
          return {
            content: [{ type: "text", text: `Too many background tasks (max ${MAX_TASKS}). Kill one first.` }],
            details: {},
          };
        }
        await mkdir(LOG_DIR, { recursive: true });
        const id = `bg${++seq}`;
        const logFile = join(LOG_DIR, `${id}.log`);

        const child = spawn(cmd, {
          shell: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const task: BgTask = {
          id,
          pid: child.pid ?? 0,
          command: cmd,
          started: new Date().toISOString(),
          status: "running",
          exitCode: null,
          logFile,
        };
        tasks.set(id, task);
        children.set(id, child);

        // Stream output to the log file.
        let logData = "";
        child.stdout?.on("data", (d) => { logData += d.toString(); void writeFile(logFile, logData); });
        child.stderr?.on("data", (d) => { logData += d.toString(); void writeFile(logFile, logData); });
        child.on("exit", (code) => {
          task.status = code === 0 ? "done" : "error";
          task.exitCode = code;
          void writeFile(logFile, logData);
          children.delete(id);
        });
        child.on("error", () => {
          task.status = "error";
          children.delete(id);
        });
        // Detach so it survives Pi exit.
        child.unref();

        return {
          content: [
            { type: "text", text: `Started background task ${id} (pid ${task.pid}).\ncommand: ${cmd}\nlog: ${logFile}\nUse bg_task action=status id=${id} to check on it.` },
          ],
          details: {},
        };
      }

      if (action === "list") {
        if (tasks.size === 0) {
          return { content: [{ type: "text", text: "No background tasks." }], details: {} };
        }
        const lines = [...tasks.values()].map(
          (t) => `  ${t.id} [${t.status}] pid=${t.pid} exit=${t.exitCode ?? "-"} :: ${t.command.slice(0, 80)}`
        );
        return { content: [{ type: "text", text: `Background tasks (${tasks.size}):\n${lines.join("\n")}` }], details: {} };
      }

      const id = (params.id as string | undefined) || "";
      if (!id || !tasks.has(id)) {
        return { content: [{ type: "text", text: `Unknown task id: ${id || "(none)"}. Use action=list to see tasks.` }], details: {} };
      }

      if (action === "status") {
        const t = tasks.get(id)!;
        let tail = "";
        try {
          const log = await readFile(t.logFile, "utf8");
          tail = log.split("\n").slice(-15).join("\n");
        } catch { /* no log yet */ }
        return {
          content: [
            { type: "text", text: `Task ${id}: ${t.status} (pid ${t.pid}, exit ${t.exitCode ?? "-"})\ncommand: ${t.command}\n--- tail ---\n${tail || "(no output yet)"}` },
          ],
          details: {},
        };
      }

      if (action === "kill") {
        const t = tasks.get(id)!;
        const child = children.get(id);
        if (child) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          t.status = "killed";
          children.delete(id);
        } else {
          t.status = "killed";
        }
        return { content: [{ type: "text", text: `Killed task ${id}.` }], details: {} };
      }

      return { content: [{ type: "text", text: "Unknown action." }], details: {} };
    },
  });
}
