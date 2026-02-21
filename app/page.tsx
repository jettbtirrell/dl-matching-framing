"use client";

/**
 * Assignment input form — the main entry point for the tool.
 *
 * Why "use client"?
 * This page manages form state, SSE streaming state, and browser APIs
 * (sessionStorage) — all of which require React hooks. Server Components
 * can't do any of that.
 *
 * DATA FLOW (with streaming):
 *   1. User submits the form
 *   2. We open a fetch() to POST /api/match
 *   3. Server immediately sends { type: "scored", creators: [...] }
 *      → we render creator cards instantly (phase: "framing")
 *   4. ~2-4s later, server sends { type: "complete", results: [...] }
 *      → we write to sessionStorage and navigate to /results
 *
 * The streaming approach (step 3) is why AI products feel fast even though
 * the underlying model is slow — you show what you have immediately, then
 * fill in the rest as it arrives. The user is reading real data while
 * Claude is still writing.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Assignment, ScoredCreator } from "@/types";
import { config } from "@/lib/config";

// ─── Form field config ────────────────────────────────────────────────────────
const OPTIONAL_FIELDS = [
  {
    name: "targetAudience" as const,
    label: "Target Audience",
    placeholder:
      "e.g. Everyday US consumers, adults 25–45 feeling cost-of-living pressure",
    hint: "Demographic and/or locale",
  },
  {
    name: "values" as const,
    label: "Creator Values",
    placeholder: "e.g. Transparency, Honesty, Community",
    hint: "Values you want the creator to embody",
  },
  {
    name: "tone" as const,
    label: "Tone",
    placeholder: "e.g. Conversational, Relatable, Lightly Educational",
    hint: "How the content should feel",
  },
];

// ─── Field error ─────────────────────────────────────────────────────────────
/** Inline validation message shown below a required field that was left empty. */
function FieldError({ message }: { message: string }) {
  return (
    <span className="flex items-center gap-1 text-xs text-error">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      {message}
    </span>
  );
}

// ─── Character counter ────────────────────────────────────────────────────────
/** Shows current / max character count; changes colour as the limit approaches. */
function CharCount({ value, max }: { value: string; max: number }) {
  const n = value.length;
  const pct = n / max;
  const color =
    n >= max ? "text-error" : pct >= 0.85 ? "text-amber-500" : "text-text-subtle";
  return (
    <span className={`text-xs tabular-nums ${color}`}>
      {n}/{max}
    </span>
  );
}

// ─── Skeleton block ───────────────────────────────────────────────────────────
/**
 * Animated shimmer placeholder for AI-generated text sections.
 * Shown during the "framing" phase while Claude writes the explanations.
 */
function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md ${className ?? "bg-fill-muted"}`}
    />
  );
}

// ─── Top match badge ──────────────────────────────────────────────────────────
/** Shown on the rank-1 card only — nudges the user toward the best match. */
function TopMatchBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-framing-border bg-framing/[0.08] px-3 py-1 text-xs font-semibold text-framing">
      ★ Top Match
    </span>
  );
}

// ─── Framing-phase creator card ───────────────────────────────────────────────
/**
 * Shows a creator card during the streaming "framing" phase.
 *
 * We have all the static data from the `scored` SSE event (name, score,
 * niches, follower count, region) so we render that immediately. The AI
 * text sections ("Why they match" and "Suggested Post Framing") are replaced
 * with animated skeleton placeholders while Claude is still writing.
 *
 * Why always show initials here instead of trying the avatar URL?
 * The avatar URLs are example.com placeholders that 404. In a loading
 * state, a flash of broken image followed by initials looks worse than
 * just showing initials directly. The full results page handles the
 * image → initials fallback gracefully via onError.
 */
function FramingCreatorCard({
  sc,
  rank,
  showSummary,
}: {
  sc: ScoredCreator;
  rank: number;
  showSummary: boolean;
}) {
  const { creator } = sc;

  function formatFollowers(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  // Initials from nickname: "Alex R." → "AR"
  const initials = creator.nickname
    .split(" ")
    .filter((word) => /^[A-Za-z]/.test(word))
    .map((word) => word[0].toUpperCase())
    .slice(0, 2)
    .join("");

  const allNiches = [
    ...creator.analysis.primaryNiches,
    ...creator.analysis.secondaryNiches,
  ].slice(0, config.ui.maxNichesPerCard);

  return (
    <div
      className={`card flex flex-col gap-5${rank === 1 ? " border-2 border-framing/50 shadow-[0_0_0_1px_rgba(78,55,246,0.08),0_2px_8px_rgba(78,55,246,0.10)]" : ""}`}
    >
      {/* Header: rank, avatar, name, badge */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill-muted text-sm font-bold text-text-primary">
            {rank}
          </div>

          {/* Initials avatar — always shown here since URLs will 404 */}
          <div
            className="flex shrink-0 items-center justify-center rounded-full bg-framing font-semibold text-white"
            style={{ width: 52, height: 52, fontSize: 52 * 0.36 }}
          >
            {initials}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text-primary">
                {creator.nickname}
              </span>
              {creator.verified && (
                <span title="Verified creator" className="text-brand">
                  ✓
                </span>
              )}
            </div>
            <span className="text-sm text-text-muted">@{creator.uniqueId}</span>
          </div>
        </div>

        {rank === 1 && <TopMatchBadge />}
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-4 text-sm">
        <div>
          <span className="font-semibold text-text-primary">
            {formatFollowers(creator.followerCount)}
          </span>
          <span className="ml-1 text-text-muted">followers</span>
        </div>
        <div>
          <span className="font-semibold text-text-primary">
            {creator.videoCount}
          </span>
          <span className="ml-1 text-text-muted">videos</span>
        </div>
        <div>
          <span
            className={`font-medium ${creator.region === "US" ? "text-text-secondary" : "text-amber-600"}`}
          >
            {creator.region}
          </span>
          {creator.region !== "US" && (
            <span className="ml-1 text-xs text-amber-500/70">(non-US)</span>
          )}
        </div>
      </div>

      {/* Niche tags */}
      <div className="flex flex-wrap gap-2">
        {allNiches.map((niche) => (
          <span key={niche} className="tag">
            {niche}
          </span>
        ))}
      </div>

      {/* Creator summary — shown/hidden by the ui_creator_summary A/B variant */}
      {showSummary && (
        <p className="text-sm leading-relaxed text-text-body">
          {creator.analysis.summary}
        </p>
      )}

      {/* Divider */}
      <div className="h-px bg-border-subtle" />

      {/* "Why they match" — skeleton while Claude writes */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Why they match
        </span>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>

      {/* "Suggested Post Framing" — skeleton while Claude writes */}
      <div className="flex flex-col gap-2 rounded-xl border border-framing-border bg-framing p-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-white">
          Suggested Post Framing
        </span>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-full bg-white/20" />
          <Skeleton className="h-3.5 w-10/12 bg-white/20" />
          <Skeleton className="h-3.5 w-full bg-white/20" />
          <Skeleton className="h-3.5 w-8/12 bg-white/20" />
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

type Phase = "idle" | "scoring" | "framing";

export default function HomePage() {
  const router = useRouter();

  const [form, setForm] = useState<Assignment>({
    topic: "",
    keyTakeaway: "",
    context: "",
    targetAudience: "",
    values: "",
    tone: "",
  });

  const [phase, setPhase] = useState<Phase>("idle");
  // Populated from the "scored" SSE event — used to render creator cards
  // in the framing phase while Claude is still writing the AI text.
  const [scoredCreators, setScoredCreators] = useState<ScoredCreator[]>([]);
  // Populated from the `scored` SSE event — contains A/B variant assignments
  // for this session (e.g. { ui_creator_summary: "show", llm_provider: "claude" }).
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Tracks which required fields the user has interacted with (focused then blurred).
  // We only show validation errors after a field has been touched — showing
  // errors on an untouched empty field would be jarring on first load.
  const [touched, setTouched] = useState({
    topic: false,
    keyTakeaway: false,
    context: false,
  });

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleBlur(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const { name } = e.target;
    if (name === "topic" || name === "keyTakeaway" || name === "context") {
      setTouched((prev) => ({ ...prev, [name]: true }));
    }
  }

  // Derived invalid states — only true when touched AND empty
  const topicInvalid = touched.topic && !form.topic.trim();
  const keyTakeawayInvalid = touched.keyTakeaway && !form.keyTakeaway.trim();
  const contextInvalid = touched.context && !form.context.trim();

  // ─── UI event tracker ──────────────────────────────────────────────────────
  /** Fire-and-forget: POST a UI event to the server analytics endpoint. */
  function sendEvent(action: string, extra?: Record<string, unknown>) {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
  }

  // ─── Submit handler (SSE) ──────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Client-side validation — mark all required fields as touched so their
    // inline errors appear, then bail out without hitting the server.
    if (
      !form.topic.trim() ||
      !form.keyTakeaway.trim() ||
      !form.context.trim()
    ) {
      setTouched({ topic: true, keyTakeaway: true, context: true });
      return;
    }

    setPhase("scoring");
    sendEvent("form_submitted", { topic: form.topic });

    try {
      const response = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      // Validation failures (400s) return plain JSON, not SSE.
      // Check response.ok before attempting to read the stream.
      if (!response.ok) {
        const data = (await response.json()) as { error: string };
        throw new Error(data.error ?? `Server error ${response.status}`);
      }

      // Read the SSE stream.
      //
      // WHY MANUAL STREAM PARSING INSTEAD OF EventSource?
      // The browser's built-in EventSource API only supports GET requests.
      // We need POST (to send the assignment JSON), so we use fetch() and
      // parse the SSE format manually. The format is simple:
      //   "data: <json>\n\n"
      // We buffer incomplete lines across chunks in case a chunk boundary
      // falls mid-event.
      // response.body is always present for a 200 SSE response,
      // but the type is nullable — guard explicitly.
      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on newlines to find complete events.
        // The last element may be an incomplete line — save it in the buffer.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const event = JSON.parse(line.slice(6)) as {
            type: string;
            creators?: ScoredCreator[];
            variants?: Record<string, string>;
            results?: unknown[];
            message?: string;
          };

          if (event.type === "scored" && event.creators) {
            // Scoring is done — show creator cards immediately.
            // Claude hasn't finished yet, so the AI text will be skeletons.
            setScoredCreators(event.creators);
            if (event.variants) setVariants(event.variants);
            setPhase("framing");
          } else if (event.type === "complete" && event.results) {
            // Claude is done — store results and navigate to /results.
            sessionStorage.setItem(
              "matchResults",
              JSON.stringify(event.results),
            );
            router.push("/results");
          } else if (event.type === "error") {
            throw new Error(event.message ?? "Matching failed");
          }
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.";
      setError(message);
      setPhase("idle");
    }
  }

  // ─── Framing phase — creator cards with skeleton AI text ──────────────────
  if (phase === "scoring" || phase === "framing") {
    return (
      <div className="min-h-screen bg-surface-page px-6 py-16">
        <div className="mx-auto max-w-2xl">
          {/* Header */}
          <div className="mb-10">
            {phase === "framing" ? (
              <>
                <h1 className="text-3xl font-bold text-text-primary">
                  Your top creators
                </h1>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-border-medium border-t-brand" />
                  <p className="text-sm text-text-muted">
                    Personalized framings loading…
                  </p>
                </div>
              </>
            ) : (
              /* scoring phase — shown for < 1ms, mostly a safety state */
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-medium border-t-brand" />
                <span className="text-sm text-text-secondary">
                  Scoring creators…
                </span>
              </div>
            )}
          </div>

          {/* Creator cards */}
          {scoredCreators.length > 0 && (
            <div className="flex flex-col gap-6">
              {scoredCreators.map((sc, i) => (
                <FramingCreatorCard
                  key={sc.creator.uniqueId}
                  sc={sc}
                  rank={i + 1}
                  showSummary={variants["ui_creator_summary"] !== "hide"}
                />
              ))}
            </div>
          )}

          {/* Claude progress note */}
          {phase === "framing" && (
            <p className="mt-8 text-center text-xs text-text-subtle">
              Claude is writing personalized framings for each creator. Usually
              takes 3–6 seconds.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── Main form view ────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-surface-page px-6 py-16">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-12">
          <h1 className="mb-3 text-4xl font-bold leading-tight tracking-tight text-text-primary">
            Find your perfect
            <br />
            <span className="text-brand">creator match.</span>
          </h1>
          <p className="text-base text-text-secondary">
            Describe your campaign assignment and we&apos;ll surface the top 3
            creators from our network — each with a personalized post framing.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-8">
          {/* Required fields */}
          <div className="card flex flex-col gap-6">
            {/* Topic */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="topic"
                className="text-sm font-medium text-text-primary"
              >
                Assignment Topic *
              </label>
              <input
                id="topic"
                name="topic"
                type="text"
                className={`form-input${topicInvalid ? " border-error bg-error/[0.04]" : ""}`}
                placeholder="e.g. Shrinkflation: Less for More!"
                value={form.topic}
                onChange={handleChange}
                onBlur={handleBlur}
                maxLength={config.ui.maxChars.topic}
              />
              <div className="flex items-center justify-between">
                <div>
                  {topicInvalid && (
                    <FieldError message="Assignment Topic is required" />
                  )}
                </div>
                <CharCount value={form.topic} max={config.ui.maxChars.topic} />
              </div>
            </div>

            {/* Key Takeaway */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="keyTakeaway"
                className="text-sm font-medium text-text-primary"
              >
                Key Takeaway *
              </label>
              <textarea
                id="keyTakeaway"
                name="keyTakeaway"
                rows={2}
                className={`form-input resize-none${keyTakeawayInvalid ? " border-error bg-error/[0.04]" : ""}`}
                placeholder="The one thing the audience should walk away knowing"
                value={form.keyTakeaway}
                onChange={handleChange}
                onBlur={handleBlur}
                maxLength={config.ui.maxChars.keyTakeaway}
              />
              <div className="flex items-center justify-between">
                <div>
                  {keyTakeawayInvalid && (
                    <FieldError message="Key Takeaway is required" />
                  )}
                </div>
                <CharCount value={form.keyTakeaway} max={config.ui.maxChars.keyTakeaway} />
              </div>
            </div>

            {/* Context */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="context"
                className="text-sm font-medium text-text-primary"
              >
                Additional Context *
              </label>
              <textarea
                id="context"
                name="context"
                rows={4}
                className={`form-input resize-none${contextInvalid ? " border-error bg-error/[0.04]" : ""}`}
                placeholder="Background on the topic, any content constraints (no promotions, video length, etc.), what tone to avoid…"
                value={form.context}
                onChange={handleChange}
                onBlur={handleBlur}
                maxLength={config.ui.maxChars.context}
              />
              <div className="flex items-center justify-between">
                <div>
                  {contextInvalid && (
                    <FieldError message="Additional Context is required" />
                  )}
                </div>
                <CharCount value={form.context} max={config.ui.maxChars.context} />
              </div>
            </div>
          </div>

          {/* Optional fields */}
          <div className="card flex flex-col gap-6">
            <div>
              <span className="text-sm font-semibold text-text-primary">
                Optional
              </span>
              <p className="mt-0.5 text-xs text-text-muted">
                More detail = more precise matching
              </p>
            </div>

            {OPTIONAL_FIELDS.map((field) => (
              <div key={field.name} className="flex flex-col gap-2">
                <label
                  htmlFor={field.name}
                  className="text-sm font-medium text-text-primary"
                >
                  {field.label}
                </label>
                <input
                  id={field.name}
                  name={field.name}
                  type="text"
                  className="form-input"
                  placeholder={field.placeholder}
                  value={form[field.name] ?? ""}
                  onChange={handleChange}
                />
                <span className="text-xs text-text-subtle">{field.hint}</span>
              </div>
            ))}
          </div>

          {/* Error message */}
          {error && (
            <div className="rounded-xl border border-error bg-error/[0.05] px-4 py-3 text-sm text-error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex justify-end">
            <button type="submit" className="btn-primary">
              Find Matches →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
