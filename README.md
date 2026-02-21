# Drumbeat Creator Matching

An internal tool for Drumbeat that matches nonprofit campaign briefs to the most semantically relevant creators in the network, and generates personalized post framings for each match.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Architecture](#architecture)
3. [Creator Matching — Semantic Search](#creator-matching--semantic-search)
4. [Suggested Framing — LLM Integration](#suggested-framing--llm-integration)
5. [Data Collection & A/B Testing](#data-collection--ab-testing)
6. [Safety & Guardrails](#safety--guardrails)
7. [Production Path](#production-path)
8. [Evaluation Criteria Addressed](#evaluation-criteria-addressed)
9. [Running Locally](#running-locally)

---

## What It Does

A nonprofit client fills in a campaign brief (topic, key takeaway, context, and optional audience/values/niche/tone fields). The tool:

1. **Embeds** the brief and all creator profiles using OpenAI's embedding API, then ranks creators by cosine similarity.
2. **Streams** the top 3 matched creator cards to the UI immediately — before the LLM has finished writing anything.
3. **Generates** personalized match explanations and post framings via Claude Haiku (OpenAI gpt-4o-mini as automatic fallback), which fill in while the user is already reading the creators.

---

## Architecture

### Decision: Modular Monolith (Next.js App Router)

This is a single Next.js application. Business logic lives in `lib/` modules imported by API routes in `app/api/`. There is no separate backend service.

**Why this is the right choice for this scope:**

- **Single deployment.** One `git push` ships the entire product — no inter-service networking, no separate environment variable sets, no two things that can be out of sync with each other.
- **SSE streaming is trivial.** The progressive streaming response (creator cards immediately → AI text when ready) is a single `ReadableStream` in a route handler. With a split architecture the frontend would need to proxy or re-stream from the backend, adding a network hop and complexity for no user-facing benefit.
- **Shared types without a shared package.** `types/index.ts` is imported by both route handlers and UI components. In a split architecture this becomes a published npm package or duplicated type definitions.
- **Serverless scaling is already handled.** Vercel scales each route handler independently. The "scale the API separately from the UI" argument for microservices doesn't apply here.
- **Team and scope fit.** A prototype built by one or two people doesn't need an organizational boundary between "frontend team" and "backend team." The complexity cost of split services would exceed the benefit at this scale.

**The module structure maps directly to future service splits.** When the time comes, the boundaries are already drawn:

```
lib/embeddings.ts  →  Embedding Service
lib/scoring.ts     →  Matching Service
lib/claude.ts      →  Framing Service
```

**What I would do for a true production platform:**

For Drumbeat's actual platform, I would use a proper service split backed by AWS infrastructure:

```
Browser (React/Next.js on Vercel or CloudFront + S3)
    ↓ HTTPS
AWS Application Load Balancer + WAF
    ↓
Matching API (ECS Fargate — Node or Python)
    ↓
pgvector on RDS Postgres  ←  Creator profiles + pre-computed embeddings
```

**Why AWS over Vercel for the API:**
- ECS Fargate keeps creator embedding caches warm in memory across requests without relying on module-scope caching hacks.
- RDS Postgres with pgvector stores creator data, embeddings, campaign history, and user accounts in one place with proper access controls, backups, and joins.
- ALB provides health checks, weighted routing (blue/green deploys), and WAF integration.
- A CI/CD pipeline on GitHub Actions → ECR image build → ECS rolling deploy with proper staging/production environments replaces ad-hoc pushes.
- Infrastructure as code (Terraform or CDK) makes the environment reproducible and auditable.

**Why not now:** Setting up that infrastructure for a 16-creator prototype would spend more engineering time on infrastructure than on product. The modular monolith is a deliberate scope choice, not a shortcut — and switching to the above architecture would be an extraction of existing modules into services, not a rewrite.

### File Structure

```
app/
  api/
    match/route.ts      — SSE streaming endpoint (scoring + framing)
    events/route.ts     — Client-side UI event ingestion
  page.tsx              — Assignment form + streaming loading state
  results/page.tsx      — Final match results
  creators/page.tsx     — Internal creator roster browser (temporary)
  globals.css           — Design system: CSS variables + component classes
  layout.tsx            — Shell: NavBar, Footer, font

lib/
  embeddings.ts         — OpenAI embedding API, creator cache, cosine similarity
  scoring.ts            — Ranking: embedding similarity + non-US penalty
  claude.ts             — LLM framing: Claude primary, OpenAI fallback, shared prompt
  analytics.ts          — JSONL event logger
  experiments.ts        — Stateless A/B variant assignment

components/
  NavBar.tsx
  Footer.tsx

data/
  creators.json         — Creator profiles with pre-computed analysis

types/
  index.ts              — Shared TypeScript interfaces (Creator, Assignment, MatchResult…)
```

---

## Creator Matching — Semantic Search

### Approach and Rationale

Matching uses **embedding-based cosine similarity**, not keyword matching and not LLM ranking.

**Why not keyword matching:**
Keyword scoring uses weighted substring overlap across dimensions (niche, values, tone, audience, causes). It catches `"personal finance"` ↔ `"Personal Finance"` but misses `"consumer awareness"` ↔ `"economic anxiety"` — two strongly related concepts with no shared words. It also requires hand-tuning per-dimension weights without a principled way to know if those weights are right.

**Why not asking an LLM to rank:**
An LLM ranking call would need to happen *before* the framing call — adding 2–4 seconds before the user sees anything. It's also expensive (assignment context sent once per creator), non-deterministic (same input → different output on different runs), and doesn't scale — at 500 creators the context window fills up entirely.

**Why embeddings:**
Both the assignment brief and each creator profile are embedded into a high-dimensional vector space. Creators whose overall profile is semantically closest to the assignment rank highest, regardless of exact keyword overlap. This captures synonyms, related concepts, and paraphrasing naturally. It's also fast: after the first request, matching is one embedding API call (~100ms) plus cheap dot products in memory.

### How It Works

1. **Creator profiles are serialized** to a rich text string per creator (`lib/embeddings.ts → creatorToText`):
   ```
   Creator: @uniqueId
   Summary: <analysis.summary>
   Primary niches: <primaryNiches>
   Secondary niches: <secondaryNiches>
   Values: <apparentValues>
   Tone: <engagementStyle.tone>
   Audience interests: <audienceInterests>
   Causes: <identifiedCauses>
   ```
   Bio text, follower count, hashtags, and partnership notes are intentionally excluded — those matter for different decisions (reach, brand safety) but not for semantic relevance to a campaign topic. Mixing them into the embedding vector would corrupt what the similarity score measures.

2. **Assignment briefs are serialized** by joining all filled form fields: topic, key takeaway, context, target audience, values, niches, tone. Empty optional fields are excluded.

3. **On first request:** all creator profiles are batch-embedded in a single OpenAI API call (~150ms for 16 creators) and stored in a module-level `Map<uniqueId, vector>`. This cache is reused for every subsequent request.

4. **Per request:** the assignment brief is embedded in one API call (~100ms). This is the only per-request network cost for scoring.

5. **Cosine similarity** is computed between the assignment vector and each cached creator vector. Vectors are pre-normalized at embed time so similarity reduces to a dot product — no repeated magnitude calculation.

6. **Non-US penalty:** non-US creators' scores are multiplied by ×0.2 (80% reduction). Geographic fit is a business constraint that semantic similarity can't capture — Drumbeat campaigns target US audiences. The penalty is applied *after* similarity scoring so it doesn't distort the semantic comparison; it's a business rule layered on top.

7. Creators are sorted descending by adjusted score; top 3 are returned.

In development, the scorer logs every creator's similarity to the terminal:
```
[scoring] mindsovermoney         similarity=0.4821 region=US
[scoring] laughingledger         similarity=0.4103 region=US
[scoring] travelbytram           similarity=0.0136 region=EU  ← non-US penalty applied
```

### Embedding Model: OpenAI `text-embedding-3-small`

- **Fast:** ~150ms for a batch of 16 creators; ~100ms for a single assignment
- **Cheap:** ~$0.02 per million tokens — negligible at this scale
- **1536 dimensions:** sufficient semantic resolution for short creator profiles
- **No new dependency:** plain `fetch` against a single HTTP endpoint

### What Is Tunable

The following are adjustable without changing the algorithm:

| Knob | Location | What it controls |
|---|---|---|
| Which creator fields are embedded | `lib/embeddings.ts → creatorToText` | Richer or narrower profile representation |
| Which assignment fields are embedded | `lib/embeddings.ts → assignmentToText` | How much form detail influences matching |
| Non-US penalty factor | `lib/scoring.ts` (currently `× 0.2`) | How aggressively non-US creators are down-ranked |
| Number of results returned | `lib/scoring.ts` (currently `3`) | Result set size |
| Embedding model | `lib/embeddings.ts → embedBatch` | Cost vs. accuracy tradeoff |

**What I would explore with more time:**

- **Per-field embeddings with learnable weights.** Instead of one holistic embedding per creator, embed each dimension separately (niches, values, tone, causes) and combine similarity scores with tunable weights. This would let us say "niche match matters 2× as much as tone match" — and then A/B test those weights against actual user selection behavior to find the optimal configuration empirically rather than by guessing.
- **Feedback loop.** Log which creator the user actually engages with after seeing results. Use selection frequency as a signal to evaluate and tune the scoring approach. This is the real path to confident weighting decisions.
- **Pre-computed embeddings at build time.** A `scripts/generate-embeddings.ts` script would pre-compute and persist creator vectors so the cache is warm from the very first production request, rather than on the first real user's request.

---

## Suggested Framing — LLM Integration

### What Goes Into the Prompt

The shared prompt (`lib/claude.ts → buildPrompt`) contains:

- The full assignment brief (all 7 form fields)
- For each of the top 3 creators: nickname, handle, summary, primary/secondary niches, values, tone, content style, audience interests, causes, follower count, and their match score

The model is instructed to produce two outputs per creator:

1. **`matchExplanation`** (1–3 sentences): Why *this specific creator* fits *this specific assignment*. Explicitly instructed to reference their actual niche, tone, audience, or values — generic praise ("they have great engagement") is forbidden by the prompt.

2. **`suggestedFraming`** (2–4 sentences): A concrete content concept this creator could execute. Tailored to their established style and audience. Instructed to make each creator's framing distinct — not repeating the same angle across all three.

Output is strict JSON with a defined schema. The model is told not to use markdown code fences, and a `stripCodeFences` helper removes them anyway if a model ignores that instruction.

### Why a Single Batched Prompt for All 3 Creators

One prompt call for all three is:
- **Cheaper:** assignment context is included once, not three times
- **Faster:** one network round-trip instead of three
- **More coherent:** the model can ensure the three framings are distinct when it sees all creators at once — three separate calls would likely repeat the same angle

### Model Provider

**Primary: `claude-haiku-4-5-20251001`**

Claude Haiku was chosen because:
- **Cost:** ~$0.25/MTok input, $1.25/MTok output — among the cheapest capable models
- **Speed:** 2–4 seconds for this prompt size, acceptable when the user is already reading creator cards
- **Output quality:** Produces specific, grounded framings that reference the creator's actual profile. Haiku is well-suited for structured output tasks with a detailed prompt
- **Safety:** Anthropic's constitutional AI training reduces harmful or off-brand outputs

**Fallback: `gpt-4o-mini`**

OpenAI's gpt-4o-mini has comparable cost and speed to Haiku and runs on different infrastructure — making it a meaningful reliability fallback rather than a second call to the same provider.

**Why not GPT-4o or Claude Sonnet/Opus:**
The marginal quality improvement for structured framing generation does not justify the 5–10× cost and latency increase. Prompt engineering matters more than raw model capability for this task.

### Cost Management

- Creator embeddings: one batch call on first server startup, then free for all subsequent requests
- Assignment embedding: one call per submission — negligible
- LLM framing: one call per submission at Haiku pricing — well under $0.01 per request

The A/B experiment framework is built specifically to support cost experiments. Set `enabled: true` on the `llm_provider` experiment to route a percentage of sessions to OpenAI or any other provider, then compare cost and quality in the event logs to find the cheapest model that produces consistent results.

**Adding a new LLM provider takes three additions:**
1. A `callNewProvider(prompt: string): Promise<string>` function in `lib/claude.ts`
2. A routing branch in `generateFramings` for the new provider name
3. A variant in the `llm_provider` experiment in `lib/experiments.ts`

The prompt is built once by `buildPrompt` and passed to whichever provider runs — no duplication.

### Latency

The SSE streaming architecture is the primary latency mitigation. The user is not waiting for the LLM:

```
Form submit
    → Embedding API (~100ms)
    → "scored" SSE event → UI renders creator cards immediately
    → LLM call (2–4s, hidden behind content the user is reading)
    → "complete" SSE event → AI text fills in → navigate to /results
```

The user sees real, meaningful content within ~200ms of submitting. The LLM latency is invisible.

**What I would do with more time to reduce latency further:**

- **Stream LLM tokens to the client.** Both Claude and OpenAI support streaming token generation. Instead of waiting for the complete JSON response, we could stream tokens as they arrive and parse partial JSON progressively (using a streaming JSON parser like `@streamparser/json`). Each creator's framing would appear word-by-word rather than all at once, eliminating the remaining perceived wait.
- **Pre-warm the creator embedding cache** at server startup with a synthetic call rather than on the first real user request.

### Reliability

Three layers of protection:

1. **Primary → fallback chain.** If Claude fails for any reason (timeout, API error, quota exceeded, parse failure), `generateFramings` automatically retries with OpenAI. The client never sees a failure from a Claude outage.

2. **Parse failure handling.** If the LLM response isn't valid JSON (despite the prompt and code fence stripping), `parseFramingResponse` throws with a provider-tagged error message. This triggers the fallback chain or surfaces a specific error to the client.

3. **Positional merge fallback.** `mergeFramings` matches each framing back to the correct creator by `uniqueId` first, then falls back to positional matching if the ID is malformed (e.g. `"@mindsovermoney"` vs `"mindsovermoney"`). Results render rather than crashing on an edge case.

All failures and automatic provider switches are logged to the analytics event stream with the `provider` field set to `"openai-fallback"` — making it easy to see how often Claude falls back and why.

---

## Data Collection & A/B Testing

### What Is Logged

Every submission produces events in a newline-delimited JSON (JSONL) log:

**`assignment_submitted`** — before any async work begins:
```json
{
  "ts": "2025-02-20T14:23:11.000Z",
  "sessionId": "uuid",
  "event": "assignment_submitted",
  "data": {
    "topic": "Shrinkflation: Less for More!",
    "keyTakeaway": "...",
    "context": "...",
    "variants": { "llm_provider": "claude", "ui_creator_summary": "show" }
  }
}
```

**`match_completed`** — after the LLM returns:
```json
{
  "ts": "2025-02-20T14:23:14.421Z",
  "sessionId": "uuid",
  "event": "match_completed",
  "data": {
    "provider": "claude",
    "topCreatorIds": ["mindsovermoney", "laughingledger", "priyag_eats"],
    "latencyMs": 3241,
    "variants": { "llm_provider": "claude", "ui_creator_summary": "show" }
  }
}
```

**`provider_fallback`** — emitted when Claude fails and OpenAI takes over (logged before `match_completed`):
```json
{
  "ts": "2025-02-20T14:23:13.204Z",
  "sessionId": "uuid",
  "event": "provider_fallback",
  "data": {
    "from": "claude",
    "to": "openai",
    "reason": "Claude returned invalid JSON. First 300 chars: ...",
    "variants": { "llm_provider": "claude", "ui_creator_summary": "show" }
  }
}
```

**`ui_interaction`** — client-side actions (form submitted, etc.).

### Session Management

Sessions are tracked with a `db_sid` cookie set on the first SSE response: HttpOnly (JS cannot read it), SameSite=Lax (CSRF protection), 30-day Max-Age. Subsequent requests from the same browser reuse the same session ID, so all events from a session are correlated without requiring login.

### A/B Experiments

Variant assignment is **stateless and deterministic**: `stableHash(sessionId + ":" + experimentName)` maps each session to a bucket. The same session always gets the same variant — no database or external service required.

| Experiment | Variants | Traffic split | Status |
|---|---|---|---|
| `llm_provider` | `claude` / `openai` | 80% / 20% | Active |
| `ui_creator_summary` | `show` / `hide` | 50% / 50% | Paused (always show) |
| `scoring_approach` | placeholder | — | Disabled |

To add an experiment: add an entry to `EXPERIMENTS` in `lib/experiments.ts` with `enabled: false`, implement the variant behavior, flip to `enabled: true` when ready. To stop an experiment: set `enabled: false` — all sessions return `variants[0]` (the control).

Every logged event includes the full variant map so outcomes can always be sliced by experiment.

### Storage

**Development:** `logs/events.jsonl` (git-ignored).
**Production (this prototype on Vercel):** `/tmp/events.jsonl` (ephemeral, resets on each serverless cold start).

For a production platform I would pipe events to a proper data pipeline:
- **Segment** for event collection with a schema-validated API
- **BigQuery or Redshift** for the warehouse
- **dbt** for transformation and analysis models

Querying the current JSONL log:
```bash
# Average LLM latency by provider
jq -s '[.[] | select(.event == "match_completed")] | group_by(.data.provider)[] | {provider: .[0].data.provider, avg_ms: (map(.data.latencyMs) | add / length)}' logs/events.jsonl

# All provider fallbacks with the error reason
jq 'select(.event == "provider_fallback")' logs/events.jsonl

# Fallback rate: what % of completions required a fallback
jq -s '(map(select(.event == "provider_fallback")) | length) / (map(select(.event == "match_completed")) | length)' logs/events.jsonl
```

---

## Safety & Guardrails

### Provider-Level Safety

Both Claude and OpenAI apply content filtering at the API level. Anthropic's constitutional AI training and OpenAI's RLHF process both reduce the likelihood of outputs that are harmful, hateful, or misleading. These are large companies with strong commercial incentives to keep their models safe, and their filters apply regardless of what our prompt says.

### Application-Level Constraints

1. **Tight task scoping.** The system prompt establishes a narrow, specific role: *creative strategist helping a nonprofit match with TikTok creators for paid campaigns*. The model is given a structured input (assignment brief + creator profiles) and a structured output schema (JSON, two fields per creator). This leaves minimal surface area for the model to go off-script.

2. **Controlled data inputs.** The creator profiles injected into the prompt are our own curated data, not user-provided free text. The only user-controlled inputs are the assignment brief fields, which are used to retrieve relevant creators — they are not rendered back to the user verbatim in the LLM's output. This eliminates the most common injection attack vector.

3. **Structured output format.** Requiring strict JSON with defined fields limits the model to producing framings, not free-form commentary. It also makes the output machine-parseable and type-safe before it reaches the client.

4. **Server-side only.** API keys never leave the server. All LLM calls happen inside Next.js route handlers. The client receives only the final processed JSON result.

### What I Would Add for Production

- **Input sanitization.** Strip or reject prompt injection patterns (e.g. "ignore previous instructions") from assignment brief fields before they enter the prompt.
- **Output moderation.** Run generated framings through OpenAI's Moderation API (free) before sending to the client. Flag and log anything above the threshold; fail safe (show a "framing unavailable" message rather than surfacing a flagged output).
- **Structured output mode.** Both Claude and OpenAI support JSON mode / structured outputs that guarantee schema-valid responses, eliminating the current parse-failure → fallback path.
- **Rate limiting.** Per-session rate limiting via Upstash Redis to prevent abuse and runaway API costs.
- **Zod schema validation.** Replace loose JSON parse + cast with strict Zod schema validation on LLM responses, surfacing exactly which field failed and why.

---

## Production Path

| Concern | Current (prototype) | Production |
|---|---|---|
| Creator data | `data/creators.json` | Postgres with pgvector |
| Creator embeddings | Module-scope in-memory cache | Vector columns in DB, updated on profile change |
| Analytics storage | JSONL flat file | Segment → BigQuery |
| LLM routing | Env vars + experiment config | Same + feature flag service (LaunchDarkly) |
| Auth | None (internal URL) | Clerk or Auth0 with role-based access |
| Infrastructure | Vercel (monolith) | AWS ECS Fargate (API) + Vercel/CloudFront (frontend) |
| CI/CD | None | GitHub Actions → ECR → ECS blue/green |
| Observability | `console.log` | OpenTelemetry → Datadog |
| Rate limiting | None | Upstash Redis per-session |
| Caching | Creator embedding in memory | Framing cache in Redis (hash of assignment + creator set) |

---

## Evaluation Criteria Addressed

### Product & UX Thinking

**Clear, intuitive flow.** Three states with always-obvious progress:

1. **Form.** Required fields first (topic, takeaway, context) in the main card. Optional fields in a separate card below with the hint "More detail = more precise matching." A first-time user can submit a valid brief without reading documentation.

2. **Loading.** Creator cards appear within ~200ms of submitting — real content, not a spinner. Name, bio, follower count, niches, and region are all populated immediately from the scoring step. The AI text sections show animated shimmer placeholders. A subtitle reads "Scores are in · Personalized framings loading…" so the user knows something more is coming.

3. **Results.** Final cards with "Why they match" and "Suggested Post Framing" filled in. The top result has a distinct indigo border and "★ Top Match" badge. The structure presents a clear recommendation while showing the reasoning behind it.

**Thoughtful states.** Four failure conditions are handled:
- Field left empty on submit → inline error per field, not a page-level alert
- Server validation failure → banner with the specific message
- LLM failure → automatic retry with fallback provider; if both fail, an error event surfaces a user-readable message
- Page refresh on results → "No results found" state with a clear action to start over

**Results help users decide.** The Top Match badge and special border nudge without mandating. The creator bio provides context while framings are loading. "Why they match" explains the logic in plain language. The framing box gives a concrete content concept — not vague guidance like "post something relevant."

### Engineering Judgment

**SSE over WebSockets.** SSE is unidirectional (server → client), which is exactly what this use case requires — the client has nothing new to send once the stream opens. SSE works over plain HTTP, requires no handshake, and is supported natively by `fetch()`. WebSockets would add protocol complexity for no functional benefit.

**Embeddings over LLM-for-ranking.** Covered above in the matching section. The right tool for measuring semantic similarity at scale is an embedding model, not a generative LLM.

**One batched LLM call, not three parallel calls.** Cheaper, faster, and produces more coherent output where the model knows all three framings need to be distinct.

**Shared prompt, multiple providers.** `buildPrompt` is called once and shared between Claude and OpenAI. Adding a provider is three additions (a call function, a routing branch, an experiment variant), not a rewrite.

**Pragmatic scope choices.** No auth (internal URL security), flat file analytics (no database to manage), module-scope embedding cache (no Redis), creators in JSON (no database query). Each is a deliberate trade of production-readiness for prototype velocity, with the upgrade path documented. The structure doesn't need to change — it needs to be filled in.

### Matching Approach

**Defensible selection method.** Cosine similarity between embedding vectors is a standard, well-understood technique used in production search and recommendation systems. It requires no labeled training data, generalizes across topic domains, and degrades gracefully — even if the perfect creator doesn't exist in the network, the 3 closest matches are surfaced rather than failing.

**What signals matter and why.** The creator embedding includes summary, niches, values, tone, audience interests, and causes — the fields that capture *semantic fit* to a campaign topic. Follower count, bio text, hashtags, and partnership notes are excluded from the embedding because they measure different things (reach, brand safety history) that matter at a different stage of the decision. Mixing reach metrics into a semantic similarity vector would make the score measure something muddled.

**The non-US penalty addresses a hard business constraint.** A creator with 90% semantic similarity but a non-European audience is genuinely worse for a US-focused campaign than one with 70% similarity and a US audience. The ×0.2 penalty is applied *after* semantic scoring — it doesn't distort the comparison, it applies a business rule on top of it. The factor is a tunable constant.

**Where AI should not be used in this flow.** Routing logic, session management, A/B variant assignment, input validation, and analytics logging are all deterministic problems. Using AI for them would add cost, latency, and nondeterminism without adding value. AI is used for exactly two things: measuring semantic similarity (embeddings) and writing natural language (framing generation).

### AI Integration Quality

**Outputs are tailored, not generic.** The prompt explicitly instructs the model to reference the creator's actual niche, tone, audience, or values — and explicitly forbids generic praise. It instructs the model to make each creator's framing distinct from the others. The structured output format prevents the model from returning vague narrative when a concrete framing concept is needed.

**Prompting shows judgment.** The prompt includes the match score for each creator — not to show the user a number, but to give the model a signal about relative fit. It specifies sentence counts to bound response length. It requires `uniqueId` to exactly match the shown value (preventing hallucinated IDs). The `mergeFramings` positional fallback handles the edge case where the model returns a slightly malformed ID without crashing.

**Hardening for production.** Beyond what's in Safety & Guardrails: stream tokens to the client so framings appear word-by-word, add structured output mode to eliminate JSON parse failures, implement per-provider retry with exponential backoff before triggering the provider switch, and add a moderation step on generated output before surfacing it to users.

---

## Running Locally

```bash
npm install
```

Create `.env.local`:
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Test case to verify end-to-end:**

| Field | Value |
|---|---|
| Topic | Shrinkflation: Less for More! |
| Key Takeaway | Help people recognize shrinkflation and how it shows up in everyday purchases |
| Context | Shrinkflation happens when companies keep prices the same but reduce size/quantity/quality. Should feel like an honest personal take, not a lecture. No political endorsements, no product promotion, video under 90 seconds. |
| Target Audience | Everyday US consumers, adults feeling cost-of-living pressure |
| Niches | Lifestyle, personal finance, consumer awareness, everyday commentary |
| Tone | Conversational, relatable, honest, lightly educational |

Expected top results: finance and consumer awareness creators with US region. The scorer logs every creator's cosine similarity score to the terminal in dev mode — check the console to inspect the full ranking.

The creator roster browser is at [http://localhost:3000/creators](http://localhost:3000/creators) (temporary internal page — disable by renaming `app/creators/` to `app/_creators/`).

Event logs are written to `logs/events.jsonl` in development.
