// cache-miss-alarm.ts
//
// Cache-miss alarm (calibrated). On cache-priced providers a cache hit is ~30x
// cheaper than a miss.
// miss ~$0.22/M (off-peak) — ~31x difference.
//
// The ONLY actionable signal is a WARM->COLD drop: the previous turn was hitting
// cache well, and this turn dropped to a large miss. That means a command broke
// a warm prefix — recoverable waste.
//
// A large miss with a cold cache (fresh session, model switch, or right after
// compaction) is UNACTIONABLE and unavoidable — it is NOT flagged. This kills
// the false positives (e.g. "missed 362,839 tokens, 0% hit" right after a
// model switch or /new).
//
// Heuristics:
//   cacheHitFraction = cacheRead / input
//   missTokens       = input - cacheRead
//
// Alerts when ALL of:
//   - previous turn had a warm cache (hitFraction >= PREV_MIN_FRACTION) OR it is
//     not a "cold-start" turn, AND
//   - this turn's missTokens >= MIN_MISS_TOKENS, AND
//   - this turn's hitFraction < MIN_HIT_FRACTION (a drop from warm)
//   - and it is not a suppressible cold-start event (model switch/new session/
//     compaction just happened).
//
// Env config:
//   CACHE_ALARM_MIN_MISS_TOKENS  (default 20000)
//   CACHE_ALARM_MIN_FRACTION     (default 0.5)  -> flag when hit fraction below this
//   CACHE_ALARM_PREV_FRACTION    (default 0.5)  -> previous turn must have been >= this (warm)
//   CACHE_ALARM_THROTTLE_MS      (default 60000) -> min gap between alerts
//
// Read-only. Only observes usage; never modifies requests.
//
// Install: place in ~/.pi/agent/extensions/ and run /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_MISS_TOKENS = parseInt(process.env.CACHE_ALARM_MIN_MISS_TOKENS ?? "20000", 10);
const MIN_HIT_FRACTION = parseFloat(process.env.CACHE_ALARM_MIN_FRACTION ?? "0.5");
const PREV_MIN_FRACTION = parseFloat(process.env.CACHE_ALARM_PREV_FRACTION ?? "0.5");
const THROTTLE_MS = parseInt(process.env.CACHE_ALARM_THROTTLE_MS ?? "60000", 10);

export default function (pi: ExtensionAPI) {
  let lastAlertAt = 0;
  let lastAlertDesc = "";
  let totalMissTokens = 0;
  let totalInputTokens = 0;

  // Warm-cache suppression window: after these events the cache is expected to
  // be cold, so we do not flag big misses for a while.
  const SUPPRESS_MS = 30_000;
  let suppressUntil = 0;
  let suppressReason = "";

  // Previous turn's cache-hit fraction (to detect warm->cold drops).
  let prevHitFraction = 1; // assume warm at start (no prior turn = don't alert)

  function render(ctx: { ui: { setStatus: (k: string, v: string) => void } }) {
    if (totalInputTokens <= 0) return;
    const missPct = ((totalMissTokens / totalInputTokens) * 100).toFixed(0);
    try {
      ctx.ui.setStatus(
        "tk-cache",
        `cache: ${totalMissTokens.toLocaleString()} miss tok / ${totalInputTokens.toLocaleString()} in (${missPct}% miss)`
      );
    } catch {
      // no-op
    }
  }

  function suppress(reason: string) {
    suppressUntil = Date.now() + SUPPRESS_MS;
    suppressReason = reason;
  }

  pi.on("turn_end", (event, ctx) => {
    const usage = event.message?.usage;
    if (!usage) return;

    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const missTokens = Math.max(0, input - cacheRead);

    totalMissTokens += missTokens;
    totalInputTokens += input;
    render(ctx);

    const hitFraction = input > 0 ? cacheRead / input : 1;
    const now = Date.now();

    // Only flag a WARM->COLD drop. Require the previous turn to have been warm.
    const wasWarm = prevHitFraction >= PREV_MIN_FRACTION;
    const suppressed = now < suppressUntil;

    if (!suppressed && wasWarm && missTokens >= MIN_MISS_TOKENS && hitFraction < MIN_HIT_FRACTION) {
      const drop = ((prevHitFraction - hitFraction) * 100).toFixed(0);
      const desc = `cache dropped ${drop}pts: missed ${missTokens.toLocaleString()} input tokens (prev hit ${(prevHitFraction * 100).toFixed(0)}% -> now ${(hitFraction * 100).toFixed(0)}%)`;
      if (now - lastAlertAt > THROTTLE_MS || desc !== lastAlertDesc) {
        lastAlertAt = now;
        lastAlertDesc = desc;
        ctx.ui.notify(
          `[cache-miss] ${desc}. A warm cache just went cold — likely a command broke the prefix (new file read, big bash output). Consider /compact or /new.`,
          "error"
        );
      }
    }

    // Update previous-turn cache state for next comparison.
    if (input > 0) prevHitFraction = hitFraction;
  });

  // Expected cold-cache events: suppress alerts for a short window.
  pi.on("model_select", () => suppress("model switch"));
  pi.on("session_start", () => {
    suppress("new/resumed session");
    prevHitFraction = 1; // fresh session: assume warm so we don't false-alert
    totalMissTokens = 0;
    totalInputTokens = 0;
  });
  pi.on("session_compact", () => suppress("compaction"));

  // Optional: /tk-cache-reset to clear counters + suppression manually.
  pi.registerCommand("tk-cache-reset", {
    description: "Reset cache-miss counters and suppression window",
    handler: async (_args, ctx) => {
      totalMissTokens = 0;
      totalInputTokens = 0;
      suppress("manual reset");
      render(ctx);
      ctx.ui.notify("Cache-miss counters reset.", "info");
    },
  });
}
