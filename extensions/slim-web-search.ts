// slim-web-search.ts
//
// Slim web search for Pi — a lightweight alternative to pi-web-access (which
// registers multiple tools: web_search, code_search, fetch_content, GitHub
// cloning, PDF extraction, video understanding, curator UI).
//
// Design:
//   - COMMAND-BASED /search <query> — zero tool schemas, injects top results
//     into context. Analogue of slim-memory / slim-todo.
//   - OPTIONAL single web_search tool (enabled with SLIM_SEARCH_TOOL=1) for
//     autonomous model-triggered search. One minimal schema, not 6-8.
//
// Providers (set one key):
//   SLIM_SEARCH_PROVIDER = brave | exa | tavily | perplexity
//   BRAVE_API_KEY / EXA_API_KEY / TAVILY_API_KEY / PERPLEXITY_API_KEY
//
// If no API key is configured, /search prints setup help instead of failing.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROVIDER = process.env.SLIM_SEARCH_PROVIDER || "brave";
const TOP_K = parseInt(process.env.SLIM_SEARCH_TOP_K ?? "5", 10);
const ENABLE_TOOL = process.env.SLIM_SEARCH_TOOL === "1";
const CONFIG_FILE = join(homedir(), ".pi", "agent", "web-search.json");

// Resolve API keys from (in priority order): env vars, then a config file at
// ~/.pi/agent/web-search.json. The config file is read SYNCHRONOUSLY at call
// time (not at module load), so the key is always current and there is no
// async race condition.
//
// web-search.json format:
//   { "braveApiKey": "...", "exaApiKey": "...", "tavilyApiKey": "...", "perplexityApiKey": "..." }
function providerKey(): string | null {
  // 1. Env var (highest priority).
  const envKey =
    PROVIDER === "exa" ? process.env.EXA_API_KEY
    : PROVIDER === "tavily" ? process.env.TAVILY_API_KEY
    : PROVIDER === "perplexity" ? process.env.PERPLEXITY_API_KEY
    : process.env.BRAVE_API_KEY;
  if (envKey) return envKey;

  // 2. Config file (fallback), read fresh each call.
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const cfg = JSON.parse(raw) as Record<string, string>;
    const fileKey =
      PROVIDER === "exa" ? cfg.exaApiKey
      : PROVIDER === "tavily" ? cfg.tavilyApiKey
      : PROVIDER === "perplexity" ? cfg.perplexityApiKey
      : cfg.braveApiKey;
    return fileKey ?? null;
  } catch {
    return null;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function braveSearch(query: string, key: string, n: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(n, 20)));
  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
}

async function exaSearch(query: string, key: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: Math.min(n, 20) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Exa API ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; text?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.text ?? "").slice(0, 300) }));
}

async function tavilySearch(query: string, key: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: Math.min(n, 20) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily API ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 300) }));
}

async function perplexitySearch(query: string, key: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }], max_tokens: 500 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Perplexity API ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return [{ title: "Perplexity Answer", url: "", snippet: data.choices?.[0]?.message?.content ?? "" }];
}

async function search(query: string, n: number): Promise<SearchResult[]> {
  const key = providerKey();
  if (!key) throw new Error(`No API key set for provider "${PROVIDER}". Set ${PROVIDER === "brave" ? "BRAVE_API_KEY" : PROVIDER.toUpperCase() + "_API_KEY"}.`);
  switch (PROVIDER) {
    case "exa": return exaSearch(query, key, n);
    case "tavily": return tavilySearch(query, key, n);
    case "perplexity": return perplexitySearch(query, key, n);
    default: return braveSearch(query, key, n);
  }
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results for: ${query}`;
  return (
    `Web search results for: ${query}\n` +
    results.map((r, i) => `--- Result ${i + 1} ---\nTitle: ${r.title}\nLink: ${r.url}\nSnippet: ${r.snippet}`).join("\n\n")
  );
}

const SETUP_HELP =
  `slim-web-search needs an API key. Set one of:\n` +
  `  SLIM_SEARCH_PROVIDER=brave   BRAVE_API_KEY=...   (default)\n` +
  `  SLIM_SEARCH_PROVIDER=exa     EXA_API_KEY=...\n` +
  `  SLIM_SEARCH_PROVIDER=tavily  TAVILY_API_KEY=...\n` +
  `  SLIM_SEARCH_PROVIDER=perplexity PERPLEXITY_API_KEY=...\n` +
  `Brave free tier: https://api-dashboard.search.brave.com/register (free AI subscription, no charge).`;

export default function (pi: ExtensionAPI) {
  // /search <query> — zero tool schemas, injects results into context.
  pi.registerCommand("search", {
    description: "Web search (slim): /search <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) {
        ctx.ui.notify(`Usage: /search <query>\n\n${SETUP_HELP}`, "info");
        return;
      }
      try {
        const results = await search(query, TOP_K);
        ctx.ui.notify(formatResults(results, query), "info");
      } catch (e) {
        ctx.ui.notify(`Search failed: ${(e as Error).message}\n\n${SETUP_HELP}`, "error");
      }
    },
  });

  // Optional single web_search tool (enabled with SLIM_SEARCH_TOOL=1).
  if (ENABLE_TOOL) {
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description: `Search the web for documentation, error messages, or facts. Returns top results with title, URL, and snippet. Provider: ${PROVIDER}.`,
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        count: Type.Optional(Type.Integer({ description: "Number of results (default 5, max 20)" })),
      }),
      async execute(toolCallId, params) {
        const query = params.query as string;
        const n = (params.count as number | undefined) || TOP_K;
        const key = providerKey();
        if (!key) {
          return { content: [{ type: "text", text: SETUP_HELP }], details: {} };
        }
        try {
          const results = await search(query, n);
          return { content: [{ type: "text", text: formatResults(results, query) }], details: {} };
        } catch (e) {
          return { content: [{ type: "text", text: `Search failed: ${(e as Error).message}` }], details: {} };
        }
      },
    });
  }
}
