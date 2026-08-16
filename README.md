# pi-token-trimmer

Slim, low-overhead extensions for the [Pi coding agent](https://github.com/earendil-works/pi) that cut per-turn token overhead, track costs in real time, and replace heavy third-party packages with lightweight equivalents.

**Measured result:** trimmed per-turn token overhead from **~9,100 to ~2,300 tokens** — roughly **3× leaner than OpenCode's ~7,500-token default** — while keeping security, cost-tracking, memory, todo, background tasks, and web search.

---

## Why this exists

Pi (the TypeScript coding agent) loads everything you install into its per-turn context: every registered **tool schema** and **injected context** is sent to the model on *every single turn*, whether you use it or not. Heavy packages quietly inflate this overhead.

We measured it empirically on a pay-per-token model:

| Config | Tokens / turn |
|--------|---------------|
| Default Pi (minimal) | ~3,056 |
| Full config (all packages + extensions) | **~9,100** |
| OpenCode default | ~7,500 |
| **This repo (bare + slim extensions)** | **~2,300** |

**~77% reduction** — mostly by removing unused tool schemas, and by replacing heavy packages with command-based or single-tool equivalents.

---

## The core idea

**Three rules:**
1. **Hook-only when possible** — extensions that only listen to events (`pi.on(...)`) add *zero* tool schemas.
2. **Command-based when you can** — `/command` extensions don't appear in the model's tool list at all.
3. **One tool, not six** — when the model genuinely needs a tool, register exactly one with a minimal schema.

---

## Extensions in this repo

### Cost tracking (hook-only, ~0 per-turn overhead)

| Extension | What it does |
|-----------|--------------|
| `cost-rollup.ts` | Live per-turn + session cost widget (uses real provider-reported usage) |
| `tool-logger.ts` | Logs every tool call + cost + model; aggregates by model; detects waste (re-reads, broad scans, large output) |
| `cache-miss-alarm.ts` | Alerts on *warm→cold* cache drops (cache hits are ~31× cheaper than misses on cache-priced providers). Calibrated to ignore unavoidable cold starts (new session / model switch / compaction). |
| `budget-guard.ts` | Session + daily budget warnings |
| `context-inspector.ts` | `/ctx` — see what occupies your context window |

### Token reduction (hook-only)

| Extension | What it does |
|-----------|--------------|
| `token-saver-report.ts` | ACTIVE mode compacts `read`/`grep`/`find`/`ls` output before it enters context (~87% cut on tool output). Toggle with `TK_ACTIVE`; compaction thresholds configurable (see `/tk-status`). |

### Safety

| Extension | What it does |
|-----------|--------------|
| `bash-approval-guard.ts` | Prevents non-interactive hangs on permission prompts; logs approval decisions |

### Slim replacements for heavy packages

| This repo | Replaces | Tools registered |
|-----------|----------|------------------|
| `slim-memory.ts` | `pi-memory` (7 tools) | **0** (command + auto-inject) |
| `slim-todo.ts` | `rpiv-todo` (1 tool + TUI) | **0** (command) |
| `slim-bg-task.ts` | `pi-background-tasks` (~13 tools) | **1** (`bg_task`) |
| `slim-web-search.ts` | `pi-web-access` (6–8 tools) | **0–1** (`web_search`) |

---

## Installation

```bash
# Clone and copy the extensions you want into your Pi extensions dir
git clone https://github.com/<your-username>/pi-token-trimmer.git
cp pi-token-trimmer/extensions/*.ts ~/.pi/agent/extensions/
cp -r pi-token-trimmer/extensions/lib ~/.pi/agent/extensions/   # shared helper (danger-patterns)
```

Then run `/reload` in Pi.

> **No build step needed.** Pi loads `.ts` extensions directly (via jiti) at
> runtime — there is no `package.json`/`tsconfig.json` requirement and nothing to
> compile. Just copy the files and `/reload`.

> **Shared module:** `extensions/lib/danger-patterns.ts` is imported by
> `bash-approval-guard.ts` and `slim-bg-task.ts`. Pi auto-loads top-level `*.ts`
> and `*/index.ts` as extensions, but files in `extensions/lib/` are NOT treated
> as standalone extensions — they're just importable helpers. Copy the whole
> `lib/` directory.

### Environment configuration

Persist these (Windows: `setx`, Unix: `export`):

```bash
# Cost / token saving
PI_CACHE_RETENTION=long        # extended prompt caching (hits ~31x cheaper)
TK_ACTIVE=1                    # enable active tool-output compaction
SESSION_BUDGET_USD=0.50        # session budget (warns at 80%, hard at 95%)
DAILY_BUDGET_USD=2.00          # daily budget

# token-saver compaction thresholds (defaults shown; dial DOWN to keep more context)
TK_READ_HEAD=50                # head lines kept per read
TK_READ_SIG=60                 # signature lines per read
TK_GREP_PER_FILE=15            # matches per file
TK_GREP_LINE_LEN=160           # max line length
TK_LS_MAX=40                   # entries kept per ls

# Web search (slim-web-search)
SLIM_SEARCH_PROVIDER=brave     # brave | exa | tavily | perplexity
SLIM_SEARCH_TOOL=1             # enable the web_search tool (optional; 0 = command only)

# Optional
SLIM_BG_MAX=10                 # max background tasks
SLIM_MEMORY_MAX=4000           # max chars auto-injected from memory
```

### API key (web search)

Slim-web-search reads keys from env **or** a config file `~/.pi/agent/web-search.json`:

```json
{ "braveApiKey": "your-key" }
```

---

## Recommended minimal `settings.json`

```json
{
  "packages": ["npm:@gotgenes/pi-permission-system"],
  "skills": [],
  "defaultProvider": "<your-provider>",
  "defaultModel": "<your-model>",
  "defaultThinkingLevel": "low"
}
```

The **permission-system** is kept (structural safety — it's a gate, not a schema-heavy toolset). Everything else that's heavy is re-added **per-project** via `.pi/settings.json` only where needed.

---

## How we measured it

Per-turn overhead is measured from the model's own `usage` metadata: run a trivial prompt (`say ok`) and read the first assistant message's `input`/`totalTokens`. Diff configs to isolate what each package/extension adds.

---

## License

MIT
