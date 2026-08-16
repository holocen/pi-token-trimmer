# COMPOSITION — Pi Slim Extension Stack

Maintenance guide for the Pi extension stack in this repo.

**Total: 11 extensions, ~2,057 lines, 15 commands, 2 LLM tools.** Shared helper: `lib/danger-patterns.ts` (imported by bash-approval-guard + slim-bg-task).

---

## Quick summary table

| File | Type | Cost | Commands | Tools | Hooks |
|------|------|------|----------|-------|-------|
| `token-saver-report.ts` | hook | ~0 | `/tk-save`, `/tk-mode`, `/tk-status` | — | `tool_result` |
| `tool-logger.ts` | hook | ~0 | `/tk-log`, `/tk-cost`, `/tk-waste` | — | `model_select`, `session_start`, `tool_call`, `tool_result` |
| `cost-rollup.ts` | hook | ~0 | — | — | `model_select`, `session_compact`, `session_start`, `turn_end` |
| `cache-miss-alarm.ts` | hook | ~0 | `/tk-cache-reset` | — | `model_select`, `session_compact`, `session_start`, `turn_end` |
| `budget-guard.ts` | hook | ~0 | `/tk-budget` | — | `session_start`, `turn_end` |
| `bash-approval-guard.ts` | hook | ~0 | `/tk-bashlog` | — | `tool_call` |
| `context-inspector.ts` | command | ~0 | `/ctx` | — | — |
| `slim-memory.ts` | command | ~0* | `/mem` (add/show/clear/import/fork/decision/restore/forks) | — | `before_agent_start` |
| `slim-todo.ts` | command | ~0 | `/todo` (add/list/done/rm/clear/path) | — | — |
| `slim-bg-task.ts` | tool | ~165 | — | `bg_task` | — |
| `slim-web-search.ts` | command+tool | ~165 | `/search` | `web_search` | — |

\* `slim-memory` costs ~size of notes injected per turn (default cap 4000 chars).

**Total per-turn overhead: ~2,300 tokens** (bare baseline ~2,100 + ~165 bg_task + ~165 web_search).

---

## Core principle (why these are cheap)

1. **Hook-only** extensions (`pi.on(...)`) add **0** tool schemas — invisible to per-turn prompt.
2. **Command-based** (`registerCommand`) don't appear in the model's tool list — 0 per-turn cost.
3. **Only register a tool** when the model must call it autonomously (`bg_task`, `web_search`).

---

## File-by-file

### 1. `token-saver-report.ts` (385 lines) — tool-output compaction
- **Purpose:** In ACTIVE mode (`TK_ACTIVE=1`), compacts `read`/`grep`/`find`/`ls` results before they enter context (~87% cut on tool output). Also reports savings.
- **Hooks:** `tool_result`
- **Commands:** `/tk-save` (report), `/tk-mode` (show mode), `/tk-status` (show active thresholds)
- **Env:** `TK_ACTIVE` (`1` = compact output); thresholds configurable: `TK_READ_HEAD` (50), `TK_READ_SIG` (60), `TK_GREP_PER_FILE` (15), `TK_GREP_LINE_LEN` (160), `TK_LS_MAX` (40)
- **Key logic:** `compactRead` (head+signatures), `compactGrep` (group by file), `compactFind` (dir counts), `compactLs` (grouped). `tool_result` handler must **return** a content patch (`{ content: [...] }`), not mutate `event.content`.
- **Rebuild note:** Compaction happens at generation time (only `tool_result` hook) — it never retroactively edits already-cached history, so it doesn't poison prefix-cache. Thresholds are env-tunable for quality tradeoffs.

### 2. `tool-logger.ts` (382 lines) — cost & waste logging
- **Purpose:** Appends every tool call + result to `~/.pi/agent/tool-log.jsonl` with cost + model; detects waste (re-reads, broad scans, large output).
- **Hooks:** `tool_call` (log start), `tool_result` (log result+flags), `session_start`, `model_select`
- **Commands:** `/tk-log`, `/tk-cost` (by model), `/tk-waste` (waste-flagged entries)
- **Env:** none
- **Files:** `~/.pi/agent/tool-log.jsonl`
- **Key logic:** `detectWaste()` flags `re-read:3x`, `broad-scan`, `large-output:Ntok`. Cost estimate = `ctx.model.cost.input × outputTokens`.

### 3. `cost-rollup.ts` (96 lines) — live cost widget
- **Purpose:** Footer widget: `this turn $X | session $Y` + top-2 models by cost.
- **Hooks:** `turn_end`, `session_start`, `model_select`, `session_compact`
- **Env:** none
- **Files:** none (reads session entries)
- **Key logic:** `entryCost()` buckets entries into `provider/model`, `tools`, `summaries`, `unknown`. **Filters out zero-cost buckets** so `unknown $0.0000` doesn't show.

### 4. `cache-miss-alarm.ts` (135 lines) — cache-break alarm
- **Purpose:** Alerts on *warm→cold* cache drops (cache hits ~31× cheaper than misses on cache-priced providers). **Calibrated** to ignore cold starts (new session/model switch/compaction).
- **Hooks:** `turn_end`, `model_select`, `session_start`, `session_compact`
- **Commands:** `/tk-cache-reset`
- **Env:** `CACHE_ALARM_MIN_MISS_TOKENS` (20k), `CACHE_ALARM_MIN_FRACTION` (0.5), `CACHE_ALARM_PREV_FRACTION` (0.5), `CACHE_ALARM_THROTTLE_MS` (60k)
- **Key logic:** Only flags when `prevHitFraction >= PREV_MIN_FRACTION` AND current `missTokens >= MIN_MISS_TOKENS` AND `hitFraction < MIN_HIT_FRACTION`. Suppresses 30s after model switch/session/compact.

### 5. `budget-guard.ts` (161 lines) — budget warnings
- **Purpose:** Warns at `WARN_AT`% and hard-warns at `HARD_AT`% of a session/daily budget.
- **Hooks:** `turn_end`, `session_start`
- **Commands:** `/tk-budget`
- **Env:** `SESSION_BUDGET_USD`, `DAILY_BUDGET_USD`, `BUDGET_WARN_AT` (0.8), `BUDGET_HARD_AT` (0.95)
- **Files:** `~/.pi/agent/budget-state.json` (daily rolling cost)

### 6. `bash-approval-guard.ts` (80 lines) — non-interactive hang prevention
- **Purpose:** In non-interactive modes (json/rpc/print), refuses risky bash immediately instead of hanging. Logs decisions.
- **Hooks:** `tool_call`
- **Commands:** `/tk-bashlog`
- **Env:** `BASH_QUEUE_INTERACTIVE` (optional; off by default)
- **Files:** `~/.pi/agent/bash-approvals.jsonl`
- **Key logic:** Uses shared `isDangerousCommand()` from `lib/danger-patterns.ts`. `ctx.mode !== "tui"` → block with clear reason.

### 7. `context-inspector.ts` (134 lines) — `/ctx`
- **Purpose:** Shows context usage, system prompt size, session entries by type, session cost, largest tool results.
- **Commands:** `/ctx`
- **Env:** none
- **Files:** none (reads session entries + `ctx.getContextUsage()`)

### 8. `slim-memory.ts` (181 lines) — cross-session memory
- **Purpose:** Command-based memory. Auto-injects saved notes into system prompt each turn. Decision/fork tagging for traceability.
- **Commands:** `/mem add|show|clear|import|fork|decision|restore|forks`
- **Hooks:** `before_agent_start` (inject memory)
- **Env:** `SLIM_MEMORY_FILE`, `SLIM_MEMORY_MAX` (4000)
- **Files:** `~/.pi/agent/slim-memory.md`
- **Key logic:** `before_agent_start` appends memory to `systemPrompt`. Keeps the NEWEST entries (tail-truncation, not head).

### 9. `slim-todo.ts` (130 lines) — todo list
- **Purpose:** Command-based checkbox todo in a markdown file.
- **Commands:** `/todo add|list|done|rm|clear|path`
- **Env:** `SLIM_TODO_FILE`
- **Files:** `~/.pi/agent/slim-todo.md`
- **Key logic:** Parses `- [x] text` lines; numbering is 1-based display.

### 10. `slim-bg-task.ts` (183 lines) — background tasks
- **Purpose:** Single `bg_task` tool to run long shell commands in the background (detached), check status/kill.
- **Tools:** `bg_task` (start/status/kill/list)
- **Env:** `SLIM_BG_MAX` (10), `SLIM_BG_LOG`
- **Files:** `~/.pi/agent/bg/<id>.log`
- **Key logic:** `child_process.spawn(cmd, { shell:true, detached:true })`, streams output to log. **Security:** uses shared `isDangerousCommand()` to refuse destructive commands (closes the bash-guard bypass).

### 11. `slim-web-search.ts` (190 lines) — web search
- **Purpose:** `/search` command (0 schemas) + optional `web_search` tool. Providers: Brave/Exa/Tavily/Perplexity.
- **Commands:** `/search`
- **Tools:** `web_search` (only when `SLIM_SEARCH_TOOL=1`)
- **Env:** `SLIM_SEARCH_PROVIDER`, `BRAVE_API_KEY`/`EXA_API_KEY`/`TAVILY_API_KEY`/`PERPLEXITY_API_KEY`, `SLIM_SEARCH_TOP_K` (5), `SLIM_SEARCH_TOOL`
- **Files:** `~/.pi/agent/web-search.json` (fallback key store)
- **Key logic:** Reads key from env **or** config file **synchronously at call time** (`readFileSync`) — avoids async race that caused "No API key set".

---

## Shared helper

- `lib/danger-patterns.ts` — single source of truth for the destructive-command regex. Imported by `bash-approval-guard.ts` and `slim-bg-task.ts`. Keeps both guards' security postures in sync. **Must be copied with the extensions** (`cp -r extensions/lib ~/.pi/agent/extensions/`).

---

## Env vars (full list)

| Env var | Default | Used by |
|---------|---------|---------|
| `TK_ACTIVE` | unset | token-saver-report |
| `TK_READ_HEAD` | 50 | token-saver-report |
| `TK_READ_SIG` | 60 | token-saver-report |
| `TK_GREP_PER_FILE` | 15 | token-saver-report |
| `TK_GREP_LINE_LEN` | 160 | token-saver-report |
| `TK_LS_MAX` | 40 | token-saver-report |
| `BASH_QUEUE_INTERACTIVE` | unset | bash-approval-guard |
| `SESSION_BUDGET_USD` | 0 | budget-guard |
| `DAILY_BUDGET_USD` | 0 | budget-guard |
| `BUDGET_WARN_AT` | 0.8 | budget-guard |
| `BUDGET_HARD_AT` | 0.95 | budget-guard |
| `CACHE_ALARM_MIN_MISS_TOKENS` | 20000 | cache-miss-alarm |
| `CACHE_ALARM_MIN_FRACTION` | 0.5 | cache-miss-alarm |
| `CACHE_ALARM_PREV_FRACTION` | 0.5 | cache-miss-alarm |
| `CACHE_ALARM_THROTTLE_MS` | 60000 | cache-miss-alarm |
| `SLIM_MEMORY_FILE` | `~/.pi/agent/slim-memory.md` | slim-memory |
| `SLIM_MEMORY_MAX` | 4000 | slim-memory |
| `SLIM_TODO_FILE` | `~/.pi/agent/slim-todo.md` | slim-todo |
| `SLIM_BG_MAX` | 10 | slim-bg-task |
| `SLIM_BG_LOG` | `~/.pi/agent/bg/` | slim-bg-task |
| `SLIM_SEARCH_PROVIDER` | brave | slim-web-search |
| `SLIM_SEARCH_TOP_K` | 5 | slim-web-search |
| `SLIM_SEARCH_TOOL` | 0 | slim-web-search |
| `BRAVE_API_KEY` | — | slim-web-search |
| `EXA_API_KEY` | — | slim-web-search |
| `TAVILY_API_KEY` | — | slim-web-search |
| `PERPLEXITY_API_KEY` | — | slim-web-search |

---

## State files

| File | Written by | Purpose |
|------|-----------|---------|
| `~/.pi/agent/tool-log.jsonl` | tool-logger | tool-call + cost log |
| `~/.pi/agent/bash-approvals.jsonl` | bash-approval-guard | approval decisions |
| `~/.pi/agent/budget-state.json` | budget-guard | daily rolling cost |
| `~/.pi/agent/slim-memory.md` | slim-memory | persistent memory + forks |
| `~/.pi/agent/slim-todo.md` | slim-todo | todo list |
| `~/.pi/agent/bg/<id>.log` | slim-bg-task | background task output |
| `~/.pi/agent/web-search.json` | (manual) | web-search API keys |

---

## Dependencies

- **Runtime:** Pi (TypeScript), Node built-ins (`node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:child_process`).
- **Pi API:** `ExtensionAPI`, `pi.on`, `pi.registerCommand`, `pi.registerTool`, type guards (`isBashToolResult`, etc.), `ctx.ui`, `ctx.sessionManager`, `ctx.model`, `ctx.getContextUsage`.
- **Third-party (npm):** `typebox` (slim-bg-task, slim-web-search tool schemas).
- **External:** none required (web-search optional key).

---

## Rebuild checklist

If an extension breaks:
1. **Token-saver** — check the `tool_result` handler **returns** a patch, doesn't mutate `event.content`. Thresholds are env-tunable.
2. **Cache-alarm** — check `prevHitFraction` tracking and suppression windows.
3. **slim-web-search** — check key resolution is `readFileSync` at call time, NOT async at module load.
4. **slim-bg-task** — check `child_process` import + `detached:true` + `unref()` + shared danger check.
5. **bash-approval-guard** — confirm it imports the shared `isDangerousCommand` (not a drifted local regex).
6. **Anything reading state files** — tolerate malformed lines; never let a parse error block execution.

---

## Design rules

- **Don't rebuild an extension** unless it saves >500 tokens/turn or adds a capability needed.
- **Keep hook/command-based by default**; add tools only when the model must act autonomously.
- **Compaction is a knob, not a fixed behavior** — tune thresholds per task quality needs.
