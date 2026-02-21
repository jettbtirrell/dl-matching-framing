/**
 * Analytics event logger — writes structured events to a JSONL file.
 *
 * FORMAT: One JSON object per line (JSONL / newline-delimited JSON).
 * Each line is a self-contained event that can be parsed independently.
 * This makes the file easy to query with tools like `jq` without loading
 * the entire file into memory.
 *
 * STORAGE:
 * - Development: <project root>/logs/events.jsonl
 * - Production (Vercel): /tmp/events.jsonl
 *   Note: /tmp is ephemeral on serverless platforms — it resets on deploy
 *   and is not shared across function instances. For production at scale,
 *   replace the appendFile call below with a write to Postgres, Supabase,
 *   PostHog, or any other persistent store. The logEvent() interface stays
 *   the same regardless of the backend.
 *
 * QUERYING EXAMPLES:
 *   # All events for a session
 *   jq 'select(.sessionId == "abc-123")' logs/events.jsonl
 *
 *   # All sessions that got the "openai" llm_provider variant
 *   jq 'select(.data.variants.llm_provider == "openai")' logs/events.jsonl
 *
 *   # Average match latency per provider
 *   jq 'select(.event == "match_completed") | {provider: .data.provider, ms: .data.latencyMs}' logs/events.jsonl
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Event type definitions
// ---------------------------------------------------------------------------

export type EventType =
  | "assignment_submitted" // form submitted and sent to the API
  | "match_completed" // scoring + framing finished, results sent to client
  | "ui_interaction"; // client-side action (button click, page view, etc.)

export interface AnalyticsEvent {
  ts: string; // ISO 8601 timestamp
  sessionId: string; // from the db_sid cookie
  event: EventType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Log path
// ---------------------------------------------------------------------------

const LOG_DIR =
  process.env.NODE_ENV === "production"
    ? "/tmp"
    : join(process.cwd(), "logs");

const LOG_PATH = join(LOG_DIR, "events.jsonl");

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Append a single structured event to the log file.
 *
 * Errors are caught and logged to console — analytics must never throw and
 * must never block or fail the main request path. A broken log file is
 * annoying but not user-facing.
 */
export async function logEvent(
  event: EventType,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const entry: AnalyticsEvent = {
    ts: new Date().toISOString(),
    sessionId,
    event,
    data,
  };

  try {
    // Ensure the logs directory exists (no-op if already present).
    // Skipped in production since /tmp always exists.
    if (process.env.NODE_ENV !== "production") {
      await mkdir(LOG_DIR, { recursive: true });
    }
    await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("[analytics] Failed to write event:", err);
  }
}
