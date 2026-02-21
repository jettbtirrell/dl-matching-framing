# Claude Code Instructions — dl-matching-framing

## Project in One Paragraph

A Next.js monolith that matches nonprofit campaign briefs to TikTok creators. The user fills in an assignment form; the server embeds the brief with OpenAI, ranks creators by cosine similarity using a 5-signal weighted score, then generates personalized match explanations and post framings via Claude Haiku. Results stream to the client progressively via SSE: creator cards appear in ~200ms, AI text fills in 2–4s later.

---

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js App Router | 16.x |
| UI | React + Tailwind CSS | 19.x / 4.x |
| Language | TypeScript (strict) | 5.x |
| Primary LLM | Claude Haiku | claude-haiku-4-5-20251001 |
| Fallback LLM | OpenAI gpt-4o-mini | — |
| Embeddings | OpenAI text-embedding-3-small | 1536D |
| Linter | Biome | 2.x |
| Analytics | PostHog HTTP API | — |

---

## Dev Commands

```bash
npm run dev                   # Start dev server (localhost:3000)
npm run build                 # Production build
npm run generate-embeddings   # Rebuild data/creator-embeddings.json
npm run lint                  # Biome lint check
npm run format                # Biome auto-format
npm run export-diagram        # Export architecture.drawio → architecture.png (requires draw.io CLI on PATH)
```

**Required env vars** (`.env.local`):
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
POSTHOG_API_KEY=phc_...              # Server-side events — omit to fall back to console.log
POSTHOG_HOST=https://app.posthog.com # Server-side host (default: app.posthog.com)
NEXT_PUBLIC_POSTHOG_KEY=phc_...      # Client-side page views (same value as POSTHOG_API_KEY)
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com  # Client-side host
```

---

## Key Files

| File | Responsibility |
|------|---------------|
| `lib/config.ts` | All tunable parameters — models, weights, limits. **No hardcoded values elsewhere.** |
| `lib/embeddings.ts` | OpenAI embedding API, module-scope creator cache, cosine similarity |
| `lib/scoring.ts` | Multi-signal weighted ranking: semantic + audience + values + tone + engagement |
| `lib/claude.ts` | LLM framing: Claude primary, OpenAI fallback, shared `buildPrompt` |
| `lib/experiments.ts` | Stateless A/B testing via `stableHash(sessionId + ":" + experimentName)` |
| `lib/analytics.ts` | Datadog HTTP API: `logEvent()` for logs, `sendMetric()` for gauges, `computeLLMCost()` |
| `app/api/match/route.ts` | Core SSE endpoint — orchestrates embedding → scoring → framing → analytics |
| `app/api/events/route.ts` | Client-side UI event ingestion |
| `app/page.tsx` | Assignment form + SSE streaming client |
| `app/results/page.tsx` | Final results display |
| `data/creators.json` | Creator profiles (source of truth) |
| `data/creator-embeddings.json` | Pre-computed 1536D vectors — committed, rebuilt by `generate-embeddings` |
| `types/index.ts` | Shared TypeScript types: Creator, Assignment, ScoredCreator, MatchResult |

---

## Common Tasks

### Add a Creator
1. Add an entry to `data/creators.json`. Key is `uniqueId` (TikTok handle without `@`).
   Required fields: `uniqueId`, `nickname`, `bio`, `followerCount`, `heartCount`, `region`, `analysis`.
2. Run `npm run generate-embeddings` — updates `data/creator-embeddings.json`.
3. Commit both files.

### Tune Scoring Weights
Edit `SETTINGS.matching.dimensionWeights` in `lib/config.ts`. Weights are normalized at runtime — they don't need to sum to 1. Set a weight to `0` to disable a dimension.

### Change the LLM Model
Edit `SETTINGS.llm.providers.claude.model` (or `.openai.model`) in `lib/config.ts`. No other files need to change.

### Update the Framing Prompt
Edit `buildPrompt()` in `lib/claude.ts`. Both Claude and OpenAI use the same prompt — one place to change.

### Add an A/B Experiment
1. Add an entry to `EXPERIMENTS` in `lib/experiments.ts` with `enabled: false`.
2. Implement the variant behavior where it's needed.
3. Set `enabled: true` to start traffic. Set `enabled: false` to stop (all sessions get `variants[0]`).

### Enable Geographic Filtering
In `lib/config.ts`, set `matching.nonUSPenalty` to a value less than `1.0` (e.g. `0.5` = 50% reduction, `0.2` = 80% reduction). Default is `1.0` (no penalty).

---

## Coding Rules

**Never hardcode tunable values.** Models, weights, token limits, character limits, and topN all live in `lib/config.ts`. If you're adding a new parameter, add it to `AppConfig`, `DEFAULTS`, and optionally `SETTINGS`.

**Analytics must never throw and must never block the request.** Call `logEvent` and `sendMetric` with `void` (fire-and-forget). Both functions catch their own errors internally.

**Embeddings and scoring are deterministic.** Don't introduce randomness or LLM calls into the ranking pipeline — embeddings rank, the LLM writes.

**The prompt is the single source of truth.** `buildPrompt()` in `lib/claude.ts` is shared between Claude and OpenAI. Don't duplicate prompts per-provider.

**SSE events have a strict contract.** The client (`app/page.tsx`) expects exactly `{ type: "scored", ... }` then `{ type: "complete", ... }`. Don't rename event types or change the payload shape without updating both sides.

**TypeScript is strict.** No `any` casts. Add types to `types/index.ts` if they're shared across modules.

---

## Where Not to Use AI

| Task | Use instead |
|------|------------|
| Creator ranking / scoring | Embeddings + cosine similarity (`lib/scoring.ts`) |
| Input validation | TypeScript + explicit checks |
| Session / cookie management | Standard HTTP cookies |
| A/B variant assignment | `stableHash()` in `lib/experiments.ts` — must be deterministic |
| Analytics logging | Direct Datadog HTTP API (`lib/analytics.ts`) |
| Error messages | Standard HTTP responses |
| Routing decisions | Next.js App Router |
