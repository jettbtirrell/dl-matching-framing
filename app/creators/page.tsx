/**
 * TEMPORARY — Creator roster browser.
 *
 * Internal-only page for reviewing all creator profiles in the dataset.
 * To disable: rename this folder to _creators (Next.js ignores _ prefixed
 * folders) or delete app/creators/.
 *
 * Route: /creators
 */

import creatorsJson from "@/data/creators.json";
import type { Creator } from "@/types";

const creators = Object.values(creatorsJson) as Creator[];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        {label}
      </span>
      {children}
    </div>
  );
}

function Pills({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-sm text-text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="tag">
          {item}
        </span>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-36 shrink-0 font-medium text-text-secondary">
        {label}
      </span>
      <span className="text-text-body">{value}</span>
    </div>
  );
}

// ─── Creator card ─────────────────────────────────────────────────────────────

function CreatorCard({ creator }: { creator: Creator }) {
  const initials = creator.nickname
    .split(" ")
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join("");

  const allNiches = [
    ...creator.analysis.primaryNiches,
    ...creator.analysis.secondaryNiches,
  ];

  return (
    <div className="card flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div
          className="flex shrink-0 items-center justify-center rounded-full bg-brand/[0.12] font-semibold text-brand"
          style={{ width: 52, height: 52, fontSize: 52 * 0.36 }}
        >
          {initials}
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold text-text-primary">
              {creator.nickname}
            </span>
            {creator.verified && (
              <span className="text-brand" title="Verified">
                ✓
              </span>
            )}
            {creator.region !== "US" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {creator.region} · non-US
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-sm text-text-muted">
            <span>@{creator.uniqueId}</span>
            <span>·</span>
            <a
              href={creator.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline-offset-2 hover:underline"
            >
              TikTok profile ↗
            </a>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap gap-6 rounded-xl border border-border-subtle bg-fill-muted px-4 py-3 text-sm">
        {[
          ["Followers", fmt(creator.followerCount)],
          ["Following", fmt(creator.followingCount)],
          ["Likes", fmt(creator.heartCount)],
          ["Videos", creator.videoCount.toString()],
          ["Analyzed", creator.videosAnalyzed.toString()],
          ["Crawls", creator.crawlCount.toString()],
        ].map(([label, val]) => (
          <div key={label}>
            <span className="font-semibold text-text-primary">{val}</span>
            <span className="ml-1 text-text-muted">{label}</span>
          </div>
        ))}
      </div>

      {/* Bio */}
      <Section label="Bio">
        <p className="whitespace-pre-line text-sm leading-relaxed text-text-body">
          {creator.bio}
        </p>
      </Section>

      {/* Summary */}
      <Section label="Analysis summary">
        <p className="text-sm leading-relaxed text-text-body">
          {creator.analysis.summary}
        </p>
      </Section>

      {/* Niches */}
      <div className="grid grid-cols-2 gap-4">
        <Section label="Primary niches">
          <Pills items={creator.analysis.primaryNiches} />
        </Section>
        <Section label="Secondary niches">
          <Pills items={creator.analysis.secondaryNiches} />
        </Section>
      </div>

      {/* Values / causes / stances */}
      <div className="grid grid-cols-3 gap-4">
        <Section label="Values">
          <Pills items={creator.analysis.apparentValues} />
        </Section>
        <Section label="Causes">
          <Pills items={creator.analysis.identifiedCauses} />
        </Section>
        <Section label="Social stances">
          <Pills items={creator.analysis.socialStances} />
        </Section>
      </div>

      {/* Engagement style */}
      <div className="flex flex-col gap-3 rounded-xl border border-brand/20 bg-brand/[0.04] p-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-brand">
          Engagement style
        </span>
        <Row label="Tone" value={creator.analysis.engagementStyle.tone.join(", ")} />
        <Row label="Content style" value={creator.analysis.engagementStyle.contentStyle} />
        <Row
          label="Calls to action"
          value={creator.analysis.engagementStyle.callsToAction.join(" · ")}
        />
      </div>

      {/* Audience */}
      <Section label="Audience interests">
        <Pills items={creator.analysis.audienceInterests} />
      </Section>

      {/* Partnership */}
      <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-fill-muted p-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Partnership potential
        </span>
        <Row
          label="Org types"
          value={creator.analysis.partnershipPotential.alignedOrganizationTypes.join(", ")}
        />
        <Row
          label="Strengths"
          value={creator.analysis.partnershipPotential.contentStrengths.join(" · ")}
        />
        <Row
          label="Considerations"
          value={creator.analysis.partnershipPotential.considerations.join(" · ")}
        />
      </div>

      {/* Hashtags */}
      <div className="grid grid-cols-2 gap-4">
        <Section label="Top hashtags">
          <Pills items={creator.analysis.topHashtags} />
        </Section>
        <Section label="Source hashtags">
          <Pills items={creator.sourceHashtags.slice(0, 8)} />
        </Section>
      </div>

      {/* Evidence / metadata */}
      <div className="flex flex-col gap-2 text-xs text-text-muted">
        <p>
          <span className="font-medium text-text-secondary">Evidence note:</span>{" "}
          {creator.analysis.evidenceNotes}
        </p>
        <p>
          Updated {new Date(creator.updatedAt).toLocaleDateString()} · Created{" "}
          {new Date(creator.createdAt).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CreatorsPage() {
  const sorted = [...creators].sort((a, b) =>
    a.nickname.localeCompare(b.nickname),
  );

  return (
    <div className="min-h-screen bg-surface-page px-6 py-16">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-10 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
              ⚠ Internal — temporary page
            </div>
            <h1 className="text-3xl font-bold text-text-primary">
              Creator Roster
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {creators.length} creators · sorted alphabetically
            </p>
          </div>
          <a href="/" className="btn-secondary shrink-0 text-sm">
            ← Back to form
          </a>
        </div>

        {/* Cards */}
        <div className="flex flex-col gap-8">
          {sorted.map((creator) => (
            <CreatorCard key={creator.uniqueId} creator={creator} />
          ))}
        </div>
      </div>
    </div>
  );
}
