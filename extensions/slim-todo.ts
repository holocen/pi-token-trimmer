// slim-todo.ts
//
// Slim, command-based todo list for Pi — a lighter alternative to rpiv-todo
// (which registers an LLM-callable todo tool with a full 4-state lifecycle +
// TUI overlay).
//
// Design: COMMAND-BASED ONLY. No LLM-callable tools, so it adds ZERO per-turn
// tool-schema overhead. State is a flat file (~/.pi/agent/slim-todo.md) of
// checkbox lines, exactly like a Markdown todo.
//
// Commands (interactive):
//   /todo add <text>        Add a task
//   /todo                  List all tasks (show pending first)
//   /todo done <n>         Mark task #n done
//   /todo rm <n>           Remove task #n
//   /todo clear            Clear all done tasks
//   /todo path             Show the todo file path
//
// Env config:
//   SLIM_TODO_FILE   override the todo file path
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const TODO_FILE = process.env.SLIM_TODO_FILE || join(homedir(), ".pi", "agent", "slim-todo.md");

interface TodoLine {
  index: number; // 1-based as displayed
  done: boolean;
  text: string;
}

async function readTodos(): Promise<TodoLine[]> {
  try {
    const raw = await readFile(TODO_FILE, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const todos: TodoLine[] = [];
    for (const line of lines) {
      const m = line.match(/^[-*] \[([ xX])\] (.*)$/);
      if (m) {
        todos.push({ index: todos.length + 1, done: m[1].toLowerCase() === "x", text: m[2].trim() });
      } else {
        todos.push({ index: todos.length + 1, done: false, text: line.replace(/^[-*]\s*/, "").trim() });
      }
    }
    return todos;
  } catch {
    return [];
  }
}

async function writeTodos(todos: TodoLine[]): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  const content = todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n");
  await writeFile(TODO_FILE, content, "utf8");
}

function formatTodos(todos: TodoLine[]): string {
  if (todos.length === 0) return "(empty)";
  return todos.map((t) => `  ${t.index}. [${t.done ? "x" : " "}] ${t.text}`).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("todo", {
    description: "Slim todo list: add/list/done/rm/clear",
    handler: async (args, ctx) => {
      const parts = (args || "").split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      const rest = parts.slice(1).join(" ").trim();
      const todos = await readTodos();

      switch (sub) {
        case "add": {
          if (!rest) {
            ctx.ui.notify("Usage: /todo add <text>", "info");
            return;
          }
          todos.push({ index: todos.length + 1, done: false, text: rest });
          await writeTodos(todos);
          ctx.ui.notify(`Added task #${todos.length}: ${rest}`, "info");
          return;
        }
        case "done": {
          const n = parseInt(rest, 10);
          if (!n || n < 1 || n > todos.length) {
            ctx.ui.notify(`Invalid task number. ${formatTodos(todos)}`, "info");
            return;
          }
          todos[n - 1].done = true;
          await writeTodos(todos);
          ctx.ui.notify(`Done: ${todos[n - 1].text}`, "info");
          return;
        }
        case "rm": {
          const n = parseInt(rest, 10);
          if (!n || n < 1 || n > todos.length) {
            ctx.ui.notify(`Invalid task number. ${formatTodos(todos)}`, "info");
            return;
          }
          const removed = todos.splice(n - 1, 1)[0];
          await writeTodos(todos);
          ctx.ui.notify(`Removed: ${removed.text}`, "info");
          return;
        }
        case "clear": {
          const remaining = todos.filter((t) => !t.done);
          await writeTodos(remaining);
          ctx.ui.notify(`Cleared done tasks. ${remaining.length} remain.`, "info");
          return;
        }
        case "path": {
          ctx.ui.notify(`Todo file: ${TODO_FILE}`, "info");
          return;
        }
        case "list":
        case "":
        default: {
          const pending = todos.filter((t) => !t.done);
          const doneCount = todos.length - pending.length;
          ctx.ui.notify(`Todos (${pending.length} pending, ${doneCount} done):\n${formatTodos(todos)}\n\nFile: ${TODO_FILE}`, "info");
          return;
        }
      }
    },
  });
}
