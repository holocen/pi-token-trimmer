# Measurement Methodology

How the per-turn overhead numbers in this repo were produced.

## The core insight

A coding agent re-sends its **entire context** on every turn. The "per-turn overhead" is the fixed cost — system prompt + all registered tool schemas + any injected context — that is billed on *every* request regardless of what the model actually does.

## How to measure

1. Run a trivial prompt with Pi in JSON mode:
   ```bash
   pi --mode json -p "say ok"
   ```
2. Read the **first assistant message** with non-zero usage from the output.
3. Its `input` + `totalTokens` fields represent the fixed per-turn context for that config.
4. Diff configs to isolate what each package/extension adds.

## Values measured (example: a pay-per-token model)

| Config | Input tokens/turn | Note |
|--------|-------------------|------|
| `pi --no-extensions` | ~3,056 | baseline, no packages |
| Default Pi (packages, no custom) | ~3,056 | |
| Bare + 2 custom extensions | ~8,975 | packages still loading |
| Full config (all packages + extensions) | ~9,103 | |
| **Bare + permission-system + custom ext** | ~2,126 | |
| **+ slim-memory + slim-todo + slim-bg-task + slim-web-search** | **~2,293–2,400** | this repo |

## Reading

- The heavy packages (pi-background-tasks ~13 tools, pi-web-access 6–8 tools, pi-task 3.4MB) were the dominant contributors.
- Our custom extensions are **hook-only** (event listeners + commands), adding ~0 tool schemas.
- The only LLM-callable tool in the slim suite is `bg_task` (1 schema) and optionally `web_search` (1 schema).

## Caveats

- Token counts are approximate; the absolute numbers vary with the system prompt length and model.
- The **relative** comparison (heavy config vs slim config) is the meaningful signal.
- Cache hits are ~31× cheaper than misses on cache-priced providers, so the effective *cost* impact of overhead depends heavily on cache behavior — but reducing raw tokens reduces both.
