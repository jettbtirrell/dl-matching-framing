/**
 * Analytics — structured event logging via PostHog HTTP API.
 *
 * POSTHOG SETUP:
 *   Add to .env.local (and Vercel project settings):
 *     POSTHOG_API_KEY=phc_...
 *     POSTHOG_HOST=https://app.posthog.com   # or your self-hosted URL
 *
 * FALLBACK:
 *   If POSTHOG_API_KEY is not set, events are written to console.log.
 *   This keeps the dev workflow unchanged — no PostHog account required locally.
 *
 * CONTRACT:
 *   Analytics must never throw and must never block the main request path.
 *   All calls are fire-and-forget (void) — errors are caught and logged only.
 *
 * EVENTS:
 *   assignment_submitted  — form submitted, before any async work
 *   match_completed       — scoring + framing done, results sent to client
 *   provider_fallback     — primary LLM failed, fallback took over
 *   ui_interaction        — client-side action (button click, page view)
 *   $ai_generation        — PostHog LLM Observability schema; emitted for both
 *                           the embedding call (provider: openai, model: text-embedding-3-small)
 *                           and the framing call (provider: anthropic or openai).
 *                           Both events share a $ai_trace_id so PostHog groups
 *                           them into one trace per request.
 *
 * All metric values (latency, token counts, cost) are captured as event
 * properties and can be visualized in PostHog Insights with Trends queries.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type EventType =
  | "assignment_submitted" // form submitted and sent to the API
  | "match_completed"      // scoring + framing finished, results sent to client
  | "provider_fallback"    // primary LLM failed; logged before the fallback call
  | "ui_interaction"       // client-side action (button click, page view, etc.)
  | "$ai_generation";      // PostHog LLM Observability — covers embedding + framing calls

// ---------------------------------------------------------------------------
// PostHog configuration
// ---------------------------------------------------------------------------

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? "";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
const ENV = process.env.NODE_ENV ?? "development";

// ---------------------------------------------------------------------------
// Event capture
// ---------------------------------------------------------------------------

/**
 * Send a structured event to PostHog.
 * Falls back to console.log if POSTHOG_API_KEY is not set.
 * Fire-and-forget — never throws, should be called with void.
 *
 * PostHog uses distinct_id to identify the user/session.
 * All additional data goes into event properties and is queryable in Insights.
 */
export async function logEvent(
  event: EventType,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = {
    api_key: POSTHOG_API_KEY,
    event,
    distinct_id: sessionId,
    properties: {
      $lib: "dl-matching-framing",
      env: ENV,
      ...data,
    },
    timestamp: new Date().toISOString(),
  };

  if (!POSTHOG_API_KEY) {
    console.log("[analytics]", JSON.stringify({ event, sessionId, ...data }));
    return;
  }

  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[analytics] Failed to send event to PostHog:", err);
  }
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/** Per-token cost in USD. Prices as of 2025. */
const COST_PER_TOKEN = {
  claude_input:  0.25 / 1_000_000,  // Claude Haiku input
  claude_output: 1.25 / 1_000_000,  // Claude Haiku output
  openai_input:  0.15 / 1_000_000,  // gpt-4o-mini input
  openai_output: 0.60 / 1_000_000,  // gpt-4o-mini output
  embedding:     0.02 / 1_000_000,  // text-embedding-3-small (total tokens)
} as const;

/** Estimate USD cost for a completed LLM framing call. */
export function computeLLMCost(
  provider: "claude" | "openai" | "openai-fallback",
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === "claude") {
    return (
      inputTokens * COST_PER_TOKEN.claude_input +
      outputTokens * COST_PER_TOKEN.claude_output
    );
  }
  return (
    inputTokens * COST_PER_TOKEN.openai_input +
    outputTokens * COST_PER_TOKEN.openai_output
  );
}

/** Estimate USD cost for an embedding call (text-embedding-3-small). */
export function computeEmbeddingCost(totalTokens: number): number {
  return totalTokens * COST_PER_TOKEN.embedding;
}
