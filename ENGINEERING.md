# Engineering PRD — Drumbeat Creator Matching

**Audience:** Engineers working on or extending this codebase.
**Purpose:** Technical spec — API contracts, module structure, configuration, how to add creators, observability setup, and the path to production hardening.

For product decisions (why we built it this way) see [PLANNING.md](PLANNING.md).

---

## System Overview

A Next.js monolith that matches nonprofit campaign briefs to TikTok creators using OpenAI embeddings for semantic ranking, then generates personalized framings via Claude Haiku (gpt-4o-mini as fallback). Results are streamed progressively to the client via Server-Sent Events.

See [architecture.drawio](architecture.drawio) (open in draw.io or VS Code with the Draw.io extension) for the full system diagram.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.x |
| UI | React + Tailwind CSS | 19.x / 4.x |
| Language | TypeScript (strict) | 5.x |
| Primary LLM | Anthropic Claude Haiku | claude-haiku-4-5-20251001 |
| Fallback LLM | OpenAI gpt-4o-mini | — |
| Embeddings | OpenAI text-embedding-3-small | 1536D |
| Linter | Biome | 2.x |
| Analytics | Datadog HTTP API | — |
| Deployment | Vercel | — |

---

## Module Responsibilities

```
lib/
  config.ts        All tunable parameters — models, weights, limits. No hardcoded values elsewhere.
  embeddings.ts    OpenAI embedding API, in-memory creator cache, cosine similarity math.
  scoring.ts       Multi-signal weighted ranking: semantic + audience + values + tone + engagement.
  claude.ts        LLM framing generation: Claude primary, OpenAI fallback, shared prompt builder.
  experiments.ts   Stateless A/B testing via hash-based deterministic variant assignment.
  analytics.ts     Datadog HTTP API: logEvent() for structured logs, sendMetric() for gauges.

app/
  page.tsx              Assignment form + SSE streaming client
  results/page.tsx      Final match results display
  creators/page.tsx     Internal roster browser (disable by renaming to _creators/)
  layout.tsx            NavBar, Footer, fonts
  api/
    match/route.ts      Core SSE endpoint — orchestrates scoring + framing + analytics
    events/route.ts     Client-side UI event ingestion (ui_interaction events)

data/
  creators.json              Creator profiles (source of truth)
  creator-embeddings.json    Pre-computed 1536D vectors (committed, rebuilt by generate-embeddings)

types/index.ts    Shared TypeScript types: Creator, Assignment, ScoredCreator, MatchResult
```

---

## API Contract

### POST /api/match

**Request body:**
```json
{
  "topic": "string (required)",
  "keyTakeaway": "string (required)",
  "context": "string (required)",
  "targetAudience": "string (optional)",
  "values": "string (optional)",
  "tone": "string (optional)"
}
```

**Response:** `text/event-stream` (SSE)

**Event 1 — scored** (fires in ~100–200ms):
```
data: {
  "type": "scored",
  "creators": [
    { "creator": { ...Creator }, "score": 0.482 },
    { "creator": { ...Creator }, "score": 0.410 },
    { "creator": { ...Creator }, "score": 0.027 }
  ],
  "variants": { "llm_provider": "claude", "ui_creator_summary": "show" }
}
```

**Event 2 — complete** (fires in ~2–4s):
```
data: {
  "type": "complete",
  "results": [
    {
      "creator": { ...Creator },
      "score": 0.482,
      "matchExplanation": "...",
      "suggestedFraming": "..."
    }
  ]
}
```

**On error:**
```
data: { "type": "error", "message": "Matching failed: ..." }
```

### POST /api/events

**Request body:**
```json
{ "action": "string", ...additionalFields }
```

Response: `200 OK` (no body)

---

## Configuration (`lib/config.ts`)

All tunable parameters live in the `SETTINGS` block. Values in `DEFAULTS` are the safe baseline — `SETTINGS` overrides only what you change.

| Key | Default | What it controls |
|-----|---------|-----------------|
| `llm.defaultProvider` | `"claude"` | Which LLM generates framings |
| `llm.providers.claude.model` | `claude-haiku-4-5-20251001` | Anthropic model ID |
| `llm.providers.openai.model` | `gpt-4o-mini` | OpenAI fallback model |
| `embeddings.model` | `text-embedding-3-small` | Embedding model (restart + re-run generate-embeddings after changing) |
| `matching.topN` | `3` | Number of creators returned |
| `matching.nonUSPenalty` | `1.0` | Score multiplier for non-US creators. `1.0` = no penalty, `0.5` = 50% reduction |
| `matching.dimensionWeights.semantic` | `0.60` | Full-profile embedding weight |
| `matching.dimensionWeights.audience` | `0.15` | Audience dimension weight |
| `matching.dimensionWeights.values` | `0.15` | Values dimension weight |
| `matching.dimensionWeights.tone` | `0.05` | Tone dimension weight |
| `matching.dimensionWeights.engagement` | `0.05` | Heart/follower ratio weight |
| `ui.maxNichesPerCard` | `4` | Niche tags shown per creator card |

---

## Adding Creators

1. Add an entry to `data/creators.json`. Key is `uniqueId` (TikTok handle without `@`).
   Minimum required fields: `uniqueId`, `nickname`, `bio`, `followerCount`, `heartCount`, `region`, `analysis` (see existing entries for the full shape).

2. Re-run embeddings:
   ```bash
   npm run generate-embeddings
   ```
   This updates `data/creator-embeddings.json` with 4 vectors per creator (full, audience, values, tone).

3. Commit both files. The app picks up the new creator immediately on next deploy.

**No database migration required.** The JSON file is the source of truth.

---

## Observability — PostHog

### Setup

Add to `.env.local` and Vercel project environment variables:
```
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://app.posthog.com    # or your self-hosted URL
```

If `POSTHOG_API_KEY` is not set, events fall back to `console.log` — no PostHog account required locally.

### What is tracked

All events are captured via PostHog's `/capture/` endpoint. Metric values (latency, tokens, cost) are captured as event properties and can be visualized in **PostHog → Insights → Trends**.

| Event | When | Key properties |
|-------|------|---------------|
| `assignment_submitted` | On form submit | topic, all assignment fields, variants |
| `api_embedding` | After embedding call | latencyMs |
| `$ai_generation` | After LLM call | `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency` (s), `$ai_total_cost_usd`, provider, fallback |
| `match_completed` | After full match | provider, topCreatorIds, latencyMs, variants |
| `provider_fallback` | When Claude fails | from, to, reason, variants |
| `ui_interaction` | Client-side actions | action |
| `$pageview` | Each page navigation | pathname (auto-captured by posthog-js) |

### Recommended Insights

In PostHog → Insights, create Trends queries on:

- **LLM dashboard** — PostHog → LLM Observability (auto-populated by `$ai_generation` events)
- Average `$ai_latency` where event = `$ai_generation`, broken down by `$ai_provider`
- Sum of `$ai_total_cost_usd` where event = `$ai_generation` over time
- Count of `provider_fallback` ÷ count of `match_completed` (fallback rate)
- Average `latencyMs` where event = `api_embedding`

---

## A/B Experiments (`lib/experiments.ts`)

Variant assignment is stateless: `stableHash(sessionId + ":" + experimentName)` maps each session to a bucket. Same session → same variant always. No database required.

| Experiment | Variants | Split | Status |
|-----------|---------|-------|--------|
| `llm_provider` | claude / openai | 80/20 | Active |
| `ui_creator_summary` | show / hide | 50/50 | Paused (always show) |
| `scoring_approach` | placeholder | — | Disabled |

To add an experiment:
1. Add an entry to `EXPERIMENTS` in `lib/experiments.ts` with `enabled: false`
2. Implement the variant behavior in the appropriate place
3. Set `enabled: true` to start traffic

To stop: set `enabled: false` — all sessions get `variants[0]` (control).

---

## Hardening for Production

| Concern | Current (prototype) | Production path |
|---------|--------------------|--------------------|
| Auth | None (internal URL) | Clerk or Auth0, RBAC |
| Rate limiting | None | Upstash Redis per-session, per-IP |
| Creator storage | `data/creators.json` | Postgres + pgvector |
| Creator embeddings | Module-scope memory cache | Vector columns in DB |
| LLM JSON reliability | Parse + fallback | Structured output mode (both Claude and OpenAI support guaranteed-schema JSON) |
| Prompt injection | None | Strip `ignore previous instructions` patterns from brief fields |
| Output safety | Provider-level filters | + OpenAI Moderation API on generated framings |
| Analytics | PostHog HTTP | Already production-ready; add Segment for richer attribution |
| Infrastructure | Vercel monolith | AWS ECS Fargate (API) + Vercel/CloudFront (frontend) |
| Caching | Memory per instance | Framing cache in Redis keyed by hash(assignment + creator set) |

### Structured output mode

Both Claude and OpenAI support guaranteed JSON output that eliminates parse-failure fallbacks:

- **OpenAI:** Set `response_format: { type: "json_schema", json_schema: {...} }` in the chat completions call.
- **Claude:** Use the `tool_use` API pattern with a tool that accepts the framing schema, or use the beta structured output header.

This removes the `parseFramingResponse` + `stripCodeFences` defense layer entirely.

---

## Deployment

**Required environment variables (Vercel):**

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
POSTHOG_API_KEY=phc_...              # Server-side events — omit to fall back to console.log
POSTHOG_HOST=https://app.posthog.com # Server-side host (default: app.posthog.com)
NEXT_PUBLIC_POSTHOG_KEY=phc_...      # Client-side page views (same value as POSTHOG_API_KEY)
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com  # Client-side host
```

**Build:**
```bash
npm run build
```

**Generate embeddings before first deploy** (or whenever creators change):
```bash
npm run generate-embeddings
```
Commit the resulting `data/creator-embeddings.json`. The app falls back to a live OpenAI API call if the file is missing, but it's slow (~800ms for 16 creators on first request).
