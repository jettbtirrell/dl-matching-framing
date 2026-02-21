# Drumbeat Creator Matching Tool

A take-home prototype for Drumbeat — a two-sided marketplace connecting nonprofits with TikTok creators for paid content assignments.

**What it does:** A nonprofit enters a campaign assignment brief and gets back the top 3 matching creators from a seed dataset, each with a personalized suggested post framing.

---

## Running Locally

```bash
# 1. Clone and install
git clone <repo>
cd dl-matching-framing
npm install

# 2. Add your API keys
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
echo "OPENAI_API_KEY=sk-..." >> .env.local

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Fill in an assignment brief and hit **Find Matches**.

### Test case to verify end-to-end

| Field | Value |
|-------|-------|
| Topic | Shrinkflation: Less for More! |
| Key Takeaway | Help people recognize shrinkflation and how it shows up in everyday purchases |
| Context | Shrinkflation happens when companies keep prices the same but reduce size/quantity/quality. Should feel like an honest personal take, not a lecture. No political endorsements, no product promotion, video under 90 seconds. |
| Target Audience | Everyday US consumers, adults feeling cost of living pressure |
| Niches | Lifestyle, personal finance, consumer awareness, everyday commentary |
| Tone | Conversational, relatable, honest, lightly educational |

**Expected top results:** Finance/consumer awareness creators with US region. The scorer logs every creator's cosine similarity score to the terminal in dev mode — check the console to inspect the ranking.

---

## Project Structure

```
/app
  page.tsx              — Assignment input form (client component)
  layout.tsx            — Root layout with Poppins font
  globals.css           — Tailwind v4 theme + Drumbeat brand colors
  /results/page.tsx     — Results display (reads from sessionStorage)
  /api/match/route.ts   — POST endpoint: score + Claude framing

/data
  creators.json         — 16 seed creator profiles (object keyed by uniqueId)

/lib
  embeddings.ts         — OpenAI embeddings, cosine similarity, creator cache
  scoring.ts            — Semantic matching: async cosine similarity ranking
  claude.ts             — Single-batch Claude API call for framings

/types
  index.ts              — Shared TypeScript interfaces
```

---

## UX Decisions

**Loading state — not just a spinner.** The loading view shows 3 labeled steps that advance as the request progresses. Why: the Claude call takes 3–6 seconds. A plain spinner with no context makes users wonder if the app is broken. Step labels ("Scoring creators… → Generating framings…") set accurate expectations and make the wait feel productive.

**Results via sessionStorage, not URL params.** Results are stored in `sessionStorage` before navigating to `/results`. The alternative — encoding results as URL params — would work for small payloads, but creator results (3 full creator objects + AI text) easily exceed 5KB, which is past the safe limit for URL length in most browsers. `sessionStorage` handles arbitrary payload sizes, keeps the URL clean, and is automatically cleared when the tab closes — appropriate for ephemeral per-session results that aren't meant to be bookmarked.

**Form divided into Required / Optional sections.** The 3 required fields (topic, takeaway, context) are in a distinct card from the 4 optional fields. This makes the minimal path obvious while surfacing the optional fields as a signal that "more detail = better match." It also mirrors how real product forms distinguish what's necessary from what's helpful.

**Avatar fallback — initials, not broken images.** All `avatarUrl` values in `creators.json` are `example.com` placeholders that 404. The `CreatorAvatar` component catches `onError` and renders a styled initials badge instead. This is realistic: real crawler data is always messy. The avatar loads optimistically and degrades gracefully.

---

## Matching Approach

### Why embeddings, not keyword scoring or AI ranking?

**Keyword scoring** (the previous approach) uses weighted substring overlap across five dimensions — niche, values, tone, audience, causes. It's fast and auditable, but misses semantic connections: "consumer awareness" and "economic anxiety" are strongly related ideas with no shared substrings, so keyword matching scores them as unrelated.

**Asking Claude to rank** would be: slow (2–4s for a call we'd need before knowing who to frame), expensive (assignment context repeated N times instead of once), non-deterministic (same input → different output), and unauditable.

**Embedding-based cosine similarity** captures *meaning* rather than string overlap. The assignment brief and each creator profile are independently embedded into a 1536-dimensional vector space; creators whose overall profile is semantically closest to the assignment rank highest — regardless of keyword overlap. This generalizes to any assignment without needing hand-tuned weights per dimension.

### How it works

1. **Creator profiles are serialized** into a single rich text string per creator: summary, primary/secondary niches, values, tone, audience interests, and identified causes.

2. **On the first request**, all creator profiles are batch-embedded in a single OpenAI API call (16 creators → 16 vectors, ~150ms). These vectors are stored in a module-level cache and reused for every subsequent request.

3. **Per request**, the assignment brief (topic + takeaway + context + optional fields) is embedded in a single API call (~100ms). This is the only per-request network overhead for scoring.

4. **Cosine similarity** is computed between the assignment vector and each cached creator vector. Scores are clamped to [0, 1].

5. **Non-US penalty** is applied after similarity scoring: non-US creators' scores are multiplied by 0.2 (80% reduction). Geographic fit is a hard constraint that semantic similarity alone can't capture — Drumbeat assignments are US-focused.

6. Creators are sorted by adjusted score descending; top 3 are returned.

In development the scorer logs similarity scores to the terminal:

```
[embeddings] Cached embeddings for 16 creators
[scoring] mindsovermoney         similarity=0.4821 region=US
[scoring] laughingledger         similarity=0.4103 region=US
[scoring] travelbytram           similarity=0.0684 region=EU  ← non-US penalty applied
```

### Model choice: OpenAI text-embedding-3-small

- Fast: batch of 16 creators in ~150ms; single assignment in ~100ms
- Cheap: ~$0.02 per million tokens (negligible at this scale)
- 1536 dimensions: good semantic resolution for short creator profiles
- No new npm package: plain `fetch` against a single HTTP endpoint

### Non-US penalty

Non-US creators have their final score multiplied by 0.2 (an 80% reduction). The data has one EU creator (`travelbytram`), one UK creator (`greenroutes`), and one CA creator (`homefixhacks`). Drumbeat assignments are US-focused; a creator with a European audience is a poor fit regardless of niche alignment. We don't exclude them entirely (edge-case: what if all creators were international?) but the penalty ensures US creators win in any realistic scenario.

---

## AI Decisions

### Why Claude?

1. **Anthropic's JSON output mode is reliable.** This function depends on machine-parseable output. Claude's instruction-following for structured JSON is consistent enough to parse without retry logic in this prototype.
2. **Drumbeat's internal stack already uses Claude.** Using the same provider shows direct integration ability with their existing tooling.

### Why a single batched prompt for all 3 creators?

Framing all 3 in one call is cheaper (assignment context is included once, not three times), faster (one network round-trip), and produces more coherent output — Claude can ensure the 3 framings are distinct when it sees all 3 at once. With 3 separate calls, it would likely repeat the same framing angle across creators.

### What guardrails exist?

- The prompt explicitly instructs Claude not to repeat the same angle across creators.
- The prompt includes assignment constraints from the context field (e.g., "no political endorsements, video under 90 seconds").
- The response is JSON-parsed and type-validated before returning to the client.
- Fallback strings are returned if Claude omits a creator from its response.

### How would you harden for production?

- Add `zod` schema validation on Claude's JSON response instead of a loose parse + cast.
- Add retry logic (exponential backoff) for transient Claude API errors.
- Add a response cache (Redis or Vercel KV) keyed on a hash of the assignment — identical briefs shouldn't re-call Claude.
- Rate-limit the endpoint (e.g., 10 req/min per IP) to prevent abuse.
- Monitor token usage and latency with Anthropic's usage API.

---

## Tech Stack Rationale

**Next.js 14 (App Router) over Flask/Express:**
Flask would require separate repos for frontend and backend, two deployments, and a CORS layer. Next.js App Router puts API routes, server logic, and UI in one repo with one deployment command. For a prototype this is the fastest path to something runnable. The App Router's Server Components/API routes also make it trivial to keep the Anthropic key server-side without any extra proxy.

**TypeScript strict mode:**
Strict mode (`"strict": true` in tsconfig) enables `strictNullChecks`, `noImplicitAny`, and `strictFunctionTypes`. These catch a large class of runtime bugs at compile time. For a prototype being reviewed live in an interview, having TypeScript surface every potential null access is valuable.

**Biome over ESLint + Prettier:**
Biome is a single binary that handles both linting and formatting — faster than ESLint + Prettier, zero config needed, and no plugin versioning conflicts to manage. The tradeoff: fewer plugins than ESLint (e.g., no `eslint-plugin-react-hooks` ecosystem). For this scope, Biome's built-in React rules are sufficient.

**Tailwind v4:**
The project was bootstrapped with Tailwind v4, which moves theme configuration into CSS (`@theme` in `globals.css`) rather than `tailwind.config.ts`. This means fewer files and a clearer separation between design tokens and code. The downside: v4 is newer and some Tailwind ecosystem tools (e.g., prettier-plugin-tailwindcss) have partial support.

**Vercel over AWS:**
Vercel is zero-configuration Next.js hosting — push to main and it deploys. AWS gives more control (custom networking, IAM, multi-region) but requires significant setup time for no benefit at this scale. Vercel also has first-class support for Next.js Edge Functions if we needed lower latency on the API route in the future.

**In-memory `creators.json` over a database:**
With 16 creators and no auth, a database adds latency, cost, and operational overhead for no benefit. Reading a JSON file at module load time is fast and simple. The tradeoff: adding creators requires a code deploy. At production scale this trades for a proper database (see below).

---

## What Would Change at Production Scale

### Matching

**Vector database for scale.** The current approach embeds all creators in memory on the first request (fine for 16 creators). With thousands of creators, we'd pre-compute and store embeddings in a vector database — Pinecone, Weaviate, or pgvector. Query becomes an approximate nearest-neighbor (ANN) search rather than an exhaustive scan, dropping latency from O(n) dot products to O(log n).

**More sophisticated scoring signals.** Current signals: niche, values, tone, audience, causes. Production signals would include: engagement rate (heartCount / followerCount), posting frequency, audience overlap with previous campaigns, past campaign performance by vertical, and verified US audience percentage (not just creator region).

### Infrastructure

**Real database.** Creator profiles would live in Postgres (structured data, relational queries) with vector columns for embeddings (pgvector), or split: Postgres for metadata + Pinecone for vectors.

**Auth.** Nonprofit clients need accounts. Creators need profiles they can manage. Drumbeat likely uses NextAuth or a managed auth provider (Auth0, Clerk).

**Rate limiting.** The current API route has no rate limiting. In production: token bucket rate limiting on the API route, keyed by user ID (not just IP), with burst allowance for legitimate power users.

**Caching.** Cache Claude framings keyed on a hash of (assignment + creator set). Identical briefs shouldn't re-generate. Vercel KV (Redis-compatible) works well here for Next.js deployments.

**Observability.** Structured logging (not `console.log`), error tracking (Sentry), and LLM-specific monitoring (latency, token usage, cost per call).

---

## What I'd Do With 1–2 More Weeks

1. **Real creator data.** The seed dataset is 16 synthetic profiles. The matching algorithm's value is directly proportional to data quality. I'd spend time on the crawler/ingestion pipeline and creator analysis schema.

2. **Assignment history and feedback loop.** Let nonprofit users rate whether a match was good. Use that signal to tune weights — or eventually to fine-tune a ranking model.

3. **Creator opt-in and profile management.** Creators should be able to claim their profile, update their niches/values, and opt into the matching pool. This requires auth, a creator dashboard, and a moderation layer.

4. **Better niche taxonomy.** The current matching uses free-text niche strings. A controlled vocabulary (a fixed enum of niche categories) would make matching more precise and let us show creators the exact categories they'd appear in.

5. **Framing approval flow.** The suggested framings from Claude are good starting points but need human review before being sent to creators. I'd add a simple review/approve/edit step between "matching" and "sending the brief."

6. **Pre-computed creator embeddings.** Currently creator embeddings are computed on the first server request and cached in memory. A build-time script (`scripts/generate-embeddings.ts`) would pre-compute and persist the vectors to a file or database so the cache is warm from the very first request.
