/**
 * POST /api/match — SSE streaming endpoint
 *
 * Returns a Server-Sent Events stream with two events:
 *
 *   1. { type: "scored", creators: ScoredCreator[] }
 *      Sent immediately after deterministic scoring finishes (< 1ms).
 *      The client renders full creator cards right away — name, score,
 *      niches, follower count. The AI text sections show as shimmer skeletons.
 *
 *   2. { type: "complete", results: MatchResult[] }
 *      Sent after Claude finishes writing framings (~2-4s).
 *      The client fills in the AI text and navigates to /results.
 *
 * WHY STREAMING? (this is the answer to "how does Google do it so fast")
 * Scoring is deterministic and takes < 1ms — there's no reason to make the
 * user wait for Claude before showing them anything. With SSE we send two
 * events at two different times: the fast result immediately, the slow result
 * when it's ready. The user sees their matches within milliseconds, then the
 * AI text materializes while they're already reading. This technique is called
 * progressive streaming and it's how virtually every modern AI product works.
 *
 * WHY SSE INSTEAD OF WEBSOCKETS?
 * SSE is unidirectional (server → client only), which is exactly what we need
 * here — the client has nothing new to send mid-stream. SSE is simpler: no
 * handshake, works over plain HTTP, supported natively by fetch(). WebSockets
 * would add complexity for zero benefit.
 *
 * WHY SSE INSTEAD OF HTTP CHUNKED TRANSFER?
 * Both use a persistent connection, but SSE has a defined event format
 * ("data: ...\n\n") that makes parsing reliable on the client side. Chunked
 * transfer is lower-level and requires more client-side parsing logic.
 *
 * This is a Next.js Route Handler (App Router). It only runs on the server,
 * which is why it's safe to import the Claude wrapper here — the API key
 * never reaches the browser.
 */

import type { NextRequest } from "next/server";
import { generateFramings } from "@/lib/claude";
import { logEvent } from "@/lib/analytics";
import { getAllVariants, getVariant } from "@/lib/experiments";
import { getTopCreators } from "@/lib/scoring";
import type { Assignment } from "@/types";

export async function POST(request: NextRequest) {
  // Parse the request body.
  // Validation errors are returned as plain JSON (not SSE) because the stream
  // hasn't opened yet — the client checks response.ok before reading the stream.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Request body must be valid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Type-narrow: treat as a dictionary so we can validate keys below.
  // We deliberately avoid casting directly to Assignment — validate first,
  // then construct the typed object from known-good values.
  const data = body as Record<string, unknown>;

  // Server-side validation of required fields.
  // Why validate here even though the form validates client-side?
  // The API is a public surface — anyone can POST directly with curl.
  // Client-side validation only guards against honest mistakes. Defense-in-depth.
  const requiredFields = ["topic", "keyTakeaway", "context"] as const;
  for (const field of requiredFields) {
    const value = data[field];
    if (!value || typeof value !== "string" || !value.trim()) {
      return new Response(
        JSON.stringify({ error: `Missing required field: "${field}"` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Build a clean, typed Assignment from the validated input.
  // We trim all strings to avoid accidentally matching on whitespace.
  // Optional fields default to undefined when absent or empty.
  const assignment: Assignment = {
    topic: (data.topic as string).trim(),
    keyTakeaway: (data.keyTakeaway as string).trim(),
    context: (data.context as string).trim(),
    targetAudience:
      typeof data.targetAudience === "string" && data.targetAudience.trim()
        ? data.targetAudience.trim()
        : undefined,
    values:
      typeof data.values === "string" && data.values.trim()
        ? data.values.trim()
        : undefined,
    niches:
      typeof data.niches === "string" && data.niches.trim()
        ? data.niches.trim()
        : undefined,
    tone:
      typeof data.tone === "string" && data.tone.trim()
        ? data.tone.trim()
        : undefined,
  };

  // ── Session management ────────────────────────────────────────────────────
  // Read the persistent session cookie (set on first visit).
  // If absent, generate a new UUID and write it into the response headers.
  let sessionId = request.cookies.get("db_sid")?.value ?? "";
  const isNewSession = !sessionId;
  if (isNewSession) sessionId = crypto.randomUUID();

  // Resolve all A/B variant assignments for this session up front.
  // Included in every logged event and in the `scored` SSE payload so the
  // client can conditionally show/hide UI elements based on its variants.
  const variants = getAllVariants(sessionId);

  // Log the form submission before any async work begins.
  void logEvent("assignment_submitted", sessionId, { ...assignment, variants });

  const encoder = new TextEncoder();

  // SSE format: each message is "data: <json>\n\n"
  // The double newline signals the end of an event to the client.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      const startMs = Date.now();

      try {
        // Step 1: Semantic scoring — embeds the assignment and computes cosine
        // similarity against cached creator embeddings. Typically < 150ms on
        // a cache hit (creator embeddings are cached after the first request).
        // Send the scored creators immediately so the client can render creator
        // cards while Claude is still working on framings.
        const topCreators = await getTopCreators(assignment);
        // Include variant assignments so the client can apply A/B UI changes.
        send({ type: "scored", creators: topCreators, variants });

        // Step 2: LLM framing — routed to Claude or OpenAI based on the
        // llm_provider experiment variant assigned to this session.
        const llmVariant = getVariant(sessionId, "llm_provider") as
          | "claude"
          | "openai";
        const { results, provider, fallbackReason } = await generateFramings(
          topCreators,
          assignment,
          { preferredProvider: llmVariant },
        );
        send({ type: "complete", results });

        // Log provider switch before the completion event so the failure reason
        // is always recorded even if match_completed logging fails.
        if (provider === "openai-fallback" && fallbackReason) {
          void logEvent("provider_fallback", sessionId, {
            from: "claude",
            to: "openai",
            reason: fallbackReason,
            variants,
          });
        }

        // Log the completed match with latency and which model actually ran.
        void logEvent("match_completed", sessionId, {
          provider,
          topCreatorIds: topCreators.map((sc) => sc.creator.uniqueId),
          latencyMs: Date.now() - startMs,
          variants,
        });
      } catch (error) {
        // Log the full error server-side (terminal / Vercel logs)
        console.error("[/api/match] Error:", error);

        // Send an error event so the client can display a message
        const message =
          error instanceof Error
            ? error.message
            : "An unexpected error occurred";
        send({ type: "error", message: `Matching failed: ${message}` });
      } finally {
        controller.close();
      }
    },
  });

  // Build response headers. Attach Set-Cookie if this is a brand-new session.
  const responseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    // No caching — each submission is a fresh match
    "Cache-Control": "no-cache",
    // Required for SSE to work in some proxy/CDN environments
    Connection: "keep-alive",
  };
  if (isNewSession) {
    // 30-day persistent cookie — HttpOnly so JS can't read it, SameSite=Lax
    // for CSRF protection. Set on the SSE response so it arrives immediately.
    responseHeaders["Set-Cookie"] =
      `db_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  }

  return new Response(stream, { headers: responseHeaders });
}
