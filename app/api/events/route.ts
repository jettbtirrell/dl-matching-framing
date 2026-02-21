/**
 * POST /api/events — client-side UI event intake.
 *
 * Called by the browser whenever a meaningful UI interaction happens (page
 * views, button clicks, etc.). The session cookie (db_sid) is attached
 * automatically by the browser since this endpoint is same-origin.
 *
 * The endpoint is intentionally fire-and-forget from the client's perspective:
 * - Returns 204 No Content on success
 * - Returns 204 even on analytics errors (never surface analytics failures to the UI)
 * - Client calls this with fetch() without awaiting the result
 */

import type { NextRequest } from "next/server";
import { logEvent } from "@/lib/analytics";

export async function POST(request: NextRequest) {
  try {
    const sessionId = request.cookies.get("db_sid")?.value ?? "anonymous";
    const body = (await request.json()) as Record<string, unknown>;

    // Require an `action` string — everything else is optional context
    const action = typeof body.action === "string" ? body.action : "unknown";

    await logEvent("ui_interaction", sessionId, {
      action,
      // Pass through any extra fields the client included (e.g., variant info)
      ...body,
    });
  } catch {
    // Analytics must never propagate errors to the client
  }

  return new Response(null, { status: 204 });
}
