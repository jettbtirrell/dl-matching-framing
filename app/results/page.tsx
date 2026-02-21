"use client";

/**
 * Results page — displays the top 3 creator matches.
 *
 * Why "use client"?
 * This page reads from sessionStorage, which is a browser API and therefore
 * only available on the client. A Server Component runs on the server at
 * request time and has no access to the user's browser storage.
 *
 * The data flow:
 *   1. User submits the form on /
 *   2. SSE stream delivers scored creators (shown immediately) then full results
 *   3. page.tsx stores results in sessionStorage and navigates here
 *   4. This page reads from sessionStorage and renders
 *
 * Trade-off: results don't survive a page refresh. That's acceptable here
 * because each submission produces a fresh match — there's no "saved result"
 * concept in this prototype. See page.tsx for the full sessionStorage vs URL
 * params trade-off discussion.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { MatchResult } from "@/types";
import { config } from "@/lib/config";

// ─── Avatar component ─────────────────────────────────────────────────────────
/**
 * Renders a creator's avatar image with a graceful fallback.
 *
 * All avatarUrl values in creators.json are example.com placeholder URLs that
 * will 404. This is realistic — real crawler data always has broken images.
 * The onError handler swaps to an initials-based fallback immediately.
 *
 * Why a regular <img> instead of Next.js <Image>?
 * next/image requires configuring remotePatterns in next.config.ts for each
 * external domain. Since these URLs will 404 anyway, there's no optimization
 * benefit from next/image here — and adding example.com to remotePatterns
 * would be misleading. A plain <img> with onError is simpler and more honest.
 */
function CreatorAvatar({
  avatarUrl,
  nickname,
  size = 56,
}: {
  avatarUrl: string;
  nickname: string;
  size?: number;
}) {
  const [hasError, setHasError] = useState(false);

  // Derive initials from nickname: "Alex R." → "AR", "Dr. Noor A." → "DN"
  const initials = nickname
    .split(" ")
    .filter((word) => /^[A-Za-z]/.test(word))
    .map((word) => word[0].toUpperCase())
    .slice(0, 2)
    .join("");

  if (hasError) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-full bg-framing font-semibold text-white"
        style={{ width: size, height: size, fontSize: size * 0.36 }}
      >
        {initials}
      </div>
    );
  }

  return (
    <>
      {/*
       * We use <img> instead of next/image intentionally.
       * These avatarUrls are example.com placeholders that will 404 — so there's
       * no LCP or optimization benefit from next/image. Adding example.com to
       * remotePatterns would be misleading. Plain <img> with onError is correct here.
       */}
      {/* biome-ignore lint/performance/noImgElement: see comment above */}
      <img
        src={avatarUrl}
        alt={`${nickname} avatar`}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
        onError={() => setHasError(true)}
      />
    </>
  );
}

// ─── Top match badge ──────────────────────────────────────────────────────────
/**
 * Shown only on the rank-1 card to nudge the user toward the best match.
 * Replaces the old numeric % score badge — cosine similarity scores are
 * meaningful for ranking but not intuitive as a user-facing percentage.
 */
function TopMatchBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-framing-border bg-framing/[0.08] px-3 py-1 text-xs font-semibold text-framing">
      ★ Top Match
    </span>
  );
}

// ─── Creator card ─────────────────────────────────────────────────────────────
function CreatorCard({ result, rank }: { result: MatchResult; rank: number }) {
  const { creator, matchExplanation, suggestedFraming } = result;

  // Format follower count: 613582 → "613.6K", 1234567 → "1.2M"
  function formatFollowers(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  const allNiches = [
    ...creator.analysis.primaryNiches,
    ...creator.analysis.secondaryNiches,
  ].slice(0, config.ui.maxNichesPerCard);

  return (
    <div
      className={`card flex flex-col gap-6${rank === 1 ? " border-2 border-framing/50 shadow-[0_0_0_1px_rgba(78,55,246,0.08),0_2px_8px_rgba(78,55,246,0.10)]" : ""}`}
    >
      {/* Card header: rank, avatar, name, meta */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {/* Rank number */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill-muted text-sm font-bold text-text-primary">
            {rank}
          </div>

          <CreatorAvatar
            avatarUrl={creator.avatarUrl}
            nickname={creator.nickname}
            size={52}
          />

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text-primary">
                {creator.nickname}
              </span>
              {creator.verified && (
                // aria-label on a plain span is not supported — title provides
                // the tooltip for sighted users; screen readers see the ✓ character.
                <span title="Verified creator" className="text-brand">
                  ✓
                </span>
              )}
            </div>
            <a
              href={creator.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-text-muted transition-colors hover:text-brand"
            >
              @{creator.uniqueId}
            </a>
          </div>
        </div>

        {rank === 1 && <TopMatchBadge />}
      </div>

      {/* Creator stats */}
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

      {/* Creator summary */}
      <p className="text-sm leading-relaxed text-text-body">
        {creator.analysis.summary}
      </p>

      {/* Divider */}
      <div className="h-px bg-border-subtle" />

      {/* Why they match — AI generated */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Why they match
        </span>
        <p className="text-sm leading-relaxed text-text-body">
          {matchExplanation}
        </p>
      </div>

      {/* Suggested framing — AI generated */}
      <div className="flex flex-col gap-2 rounded-xl border border-framing-border bg-framing p-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-white">
          Suggested Post Framing
        </span>
        <p className="text-sm leading-relaxed text-framing-text">
          {suggestedFraming}
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const router = useRouter();
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [ready, setReady] = useState(false); // prevents flash of "no results" on first render

  useEffect(() => {
    // sessionStorage is only available after the component mounts on the client.
    // We can't call it during SSR (this is why useEffect is needed).
    const raw = sessionStorage.getItem("matchResults");
    if (raw) {
      try {
        setResults(JSON.parse(raw) as MatchResult[]);
      } catch {
        // Corrupt data — treat as no results
        setResults(null);
      }
    }
    setReady(true);
  }, []);

  // Don't render anything until we've checked sessionStorage.
  // This prevents a flash of the "no results" state on load.
  if (!ready) {
    return null;
  }

  // ─── No results (navigated directly or refreshed) ─────────────────────────
  if (!results || results.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
        <div className="text-center">
          <p className="mb-2 text-4xl">🔍</p>
          <h2 className="mb-2 text-xl font-semibold text-text-primary">
            No results found
          </h2>
          <p className="text-sm text-text-muted">
            Results are cleared when you refresh or close the tab. Submit a new
            assignment to see matches.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => router.push("/")}
        >
          ← New Assignment
        </button>
      </div>
    );
  }

  // ─── Results ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-6 py-16">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-text-primary">
            Your top creators
          </h1>
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() => router.push("/")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="none"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <path
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 4L4 10m0 0l6 6M4 10h12"
              />
            </svg>
            Create New Assignment
          </button>
        </div>

        {/* Creator cards */}
        <div className="flex flex-col gap-6">
          {results.map((result, i) => (
            <CreatorCard
              key={result.creator.uniqueId}
              result={result}
              rank={i + 1}
            />
          ))}
        </div>

        {/* Footer note */}
        <p className="mt-10 text-center text-xs text-text-faint">
          Framings are AI-generated and should be reviewed before use.
        </p>
      </div>
    </div>
  );
}
