# Planning PRD — Drumbeat Creator Matching

**Audience:** Product stakeholders, hiring reviewers, future collaborators
**Purpose:** Document the product questions I faced, the options I considered, and why I made each choice — not just what was built, but why.

For the engineering spec (API contracts, module structure, how to add creators, how to harden for production) see [ENGINEERING.md](ENGINEERING.md).

---

## What This Is

An internal tool that matches nonprofit campaign briefs to the most semantically relevant TikTok creators in Drumbeat's network, then generates personalized post framings for each match.

**The core user journey:**
1. A nonprofit describes their campaign (topic, key takeaway, constraints, optional audience/values/tone).
2. The tool surfaces the three best-matched creators within ~200ms.
3. While the user reads the creator cards, the AI writes personalized match explanations and content framings (2–4s).
4. The user leaves with three concrete creator recommendations and a starting point for each brief.

---

## Questions I Faced + Decisions Made

### 1. How should matching work? Keyword search, LLM ranking, or embeddings?

**Options considered:**
- **Keyword matching:** Score creators by how many words overlap with the assignment brief. Fast, cheap, transparent.
- **LLM ranking:** Send the brief + all creator profiles to a model and ask it to rank them. Most flexible, handles nuance.
- **Embedding cosine similarity:** Convert both the assignment and creator profiles to vectors; rank by geometric distance.

**Decision: Embeddings**

Keyword matching fails on semantically related concepts with no shared words — "consumer awareness" and "economic anxiety" are strongly related but share nothing lexically. This is a real problem for a domain where the same idea is described in many different ways.

LLM ranking sounds appealing but has three compounding problems: it must happen *before* the user sees anything (adding 2–4s of blank-screen wait), it's expensive at scale, and it's non-deterministic (same input, different ranking on different calls). It also doesn't generalize — you'd need to re-send all creator profiles with every request.

Embeddings hit the right point on the cost/quality/speed curve: meaning-aware (not just keyword overlap), deterministic, ~100ms per request, negligible cost (~$0.02/MTok), and the creator vectors can be pre-computed so runtime is just the assignment embedding.

---

### 2. Should matching use a single vector or multiple dimensions?

**Options considered:**
- **Single full-profile vector:** Embed everything about each creator into one vector and compare against the full assignment.
- **Multiple targeted dimensions:** Create separate vectors for audience, values, and tone; let users signal which dimensions matter for their campaign.

**Decision: Multi-dimensional (5 signals)**

For nonprofit campaigns, audience fit and value alignment often matter as much as topical similarity. A climate nonprofit doesn't just want a creator who talks about the environment — they want one whose *audience* cares about the environment and whose *values* align with their organization.

The five signals are:
- `semantic` (60%): full-profile embedding — always active
- `audience` (15%): audience interests — active when user fills `targetAudience`
- `values` (15%): apparent values + causes + stances — active when user fills `values`
- `tone` (5%): engagement style — active when user fills `tone`
- `engagement` (5%): heart/follower ratio — always active

When optional fields are filled, their weight shifts into the total — they don't add bonus points, they replace weight from other signals. This keeps scores comparable across submissions with different field completions.

All weights are in `lib/config.ts` and can be tuned without touching the algorithm.

---

### 3. Should non-US creators be penalized or excluded?

**Options considered:**
- **Hard exclusion:** Filter out non-US creators entirely.
- **Soft penalty:** Apply a score multiplier to non-US creators (e.g. ×0.5 reduces their effective score by half).
- **No penalty:** Rank purely on semantic fit regardless of geography.

**Decision: No penalty by default (configurable)**

Most nonprofit campaigns are US-focused, but the right call depends on the campaign. Hard exclusion is irreversible and throws away potentially good matches. A penalty distorts rankings for campaigns that genuinely want international creators.

The default is now `nonUSPenalty: 1.0` (no effect). The option exists in `lib/config.ts` — set it to `0.5` for a 50% reduction, `0.2` for an 80% reduction. The README and engineering docs explain how to enable it.

---

### 4. Should the LLM rank creators or write framings?

This is the most important separation in the architecture: **embeddings rank, LLM writes.**

Using the LLM to rank would mean:
- An extra 2–4s before the user sees anything
- Non-deterministic results (rankings shift between calls)
- Higher cost per request
- No scaling path (sending all creator profiles for every request)

The LLM adds value where it can't be replaced: writing *specific, tailored, natural language* explanations for why a creator fits a brief and what they should post. A cosine similarity score can't write "Alex's 'money moments' format and audience of 25-34 cost-conscious adults is a direct match for a shrinkflation campaign that needs to feel like a personal take, not a lecture."

**Where AI is explicitly not used:** routing, session management, variant assignment, input validation, form rendering, analytics logging. These are deterministic problems; using AI for them adds cost and nondeterminism with no benefit.

---

### 5. How should the UX handle the two-speed result?

Scoring takes ~100ms. LLM framing takes 2–4s. The user shouldn't wait 2–4s for anything.

**Options considered:**
- **Wait for everything:** Show a spinner until both scoring and LLM are done. Simple but slow-feeling.
- **Show scoring immediately, LLM async:** Send the creator cards right away, fill in AI text when ready.
- **Stream LLM tokens word-by-word:** Fill in AI text progressively as tokens arrive.

**Decision: Progressive SSE (two-event stream), with word-by-word as a next step**

The `scored` SSE event fires the moment scoring finishes — typically under 200ms. The client renders real creator cards (name, bio, score, niches, follower count, region) immediately. The AI text sections show shimmer placeholders. The `complete` event fires when Claude finishes; the client fills in the text and navigates to results.

The user is reading real, meaningful content during the 2–4s Claude is running. The latency is invisible.

Word-by-word token streaming would eliminate the remaining shimmer period but adds complexity (streaming JSON parser, partial render logic). It's the top item on the "what's next" list.

---

### 6. SSE vs WebSockets vs polling for streaming?

SSE (Server-Sent Events) is unidirectional (server → client only), which is exactly what this use case needs — the client has nothing new to send once the stream opens. SSE works over plain HTTP, requires no handshake, and is supported natively by `fetch()`. WebSockets would add protocol complexity (bidirectional channel, handshake, heartbeat) for zero functional benefit. Polling would require repeated round-trips with no guarantee of timing.

---

### 7. One batched LLM call vs. three parallel calls?

Three parallel LLM calls would get framings for all creators faster in theory, but:
- **Cost:** The assignment context (the longest part of the prompt) is sent three times instead of once.
- **Coherence:** The model can't ensure the three framings are distinct when it doesn't see all three creators at once. In practice, parallel calls often repeat the same angle.
- **Complexity:** Three inflight requests to manage, three responses to parse and merge, three failure modes.

One batched call is cheaper, simpler, and produces more distinct framings because the model knows all three creators when writing each one.

---

### 8. Claude Haiku vs. other models for framing?

| Model | Input cost | Latency | Quality for this task |
|-------|-----------|---------|----------------------|
| Claude Haiku | $0.25/MTok | 2–4s | Good — specific, structured |
| Claude Sonnet | $3.00/MTok | 4–8s | Better, but 12× more expensive |
| GPT-4o-mini | $0.15/MTok | 2–4s | Comparable, different infra |
| GPT-4o | $2.50/MTok | 5–10s | Better, but 10× more expensive |

**Decision: Claude Haiku as primary, gpt-4o-mini as fallback**

The marginal quality improvement from a larger model doesn't justify the cost and latency increase for a structured generation task driven by a detailed prompt. Prompt engineering matters more than raw model capability here.

The fallback uses OpenAI rather than retrying Claude because that provides *real* infrastructure redundancy — if Claude's API is having issues, a second Claude call fails the same way. gpt-4o-mini has comparable pricing and speed and runs on different infrastructure.

---

### 9. Database vs. JSON files for creator data?

A database adds: schema migrations, connection pooling, credentials management, local dev setup, and a whole category of failure modes — for 16 creators.

JSON files work for the prototype scope. The module structure already draws the boundary where a DB would go (`lib/embeddings.ts` → embedding service, `lib/scoring.ts` → matching service). When the roster grows or creators need to be editable without a code deploy, the upgrade path is clear: move `creators.json` into Postgres with pgvector, keep the same module interfaces.

---

### 10. What fields should be required vs. optional?

**Required:** Topic, key takeaway, context. These are the minimum for a meaningful match — without them, the embedding has nothing to go on, and the LLM has no brief to frame against.

**Optional:** Target audience, values, tone. These activate additional scoring dimensions and sharpen the match, but a user who doesn't know their creator values yet can still get useful results from the semantic similarity alone. The form labels each optional field with what it unlocks: "More detail = more precise matching."

---

## UX Decisions

**What was optimized for:**
- **Speed of first result.** Creator cards in ~200ms. The user never stares at a blank screen.
- **Progressive disclosure.** Required fields first, optional fields in a separate card below. A first-time user submits a valid brief without reading documentation.
- **Results that explain themselves.** "Why they match" in 1–3 sentences. "Suggested Post Framing" as a concrete content concept. The Top Match badge and border nudge without mandating.
- **Graceful failure.** Inline per-field errors (not page-level alerts), automatic LLM fallback (Claude → OpenAI), and a user-readable error message if both fail.

**What was explicitly not optimized for:**
- Authentication (internal URL security is sufficient for a prototype)
- Mobile layout (internal tool, assumed desktop use)
- Accessibility (not production-deployed to end users)
- Persistent history (no database at this scale)

---

## What I'd Do Next (1–2 More Weeks)

**1. Stream LLM tokens word-by-word.**
Framings appear as they're typed rather than all at once. Eliminates the shimmer wait entirely. Requires a streaming JSON parser on the server and progressive render logic on the client.

**2. Track which creator the user selects.**
Right now we log which creators are *surfaced*, not which one the user *acts on*. A click event when a user copies a framing or engages with a creator gives us the outcome signal needed to evaluate whether matching is actually useful — and to tune dimension weights empirically.

**3. Structured output mode for the LLM.**
Both Claude and OpenAI support guaranteed-schema JSON output. Eliminates the current parse-failure → provider-fallback path entirely.

**4. Tune dimension weights against real selection data.**
The current weights (`semantic=0.60, audience=0.15...`) are reasonable priors. Once click-through data exists, run experiments: change weights in `config.matching.dimensionWeights` and measure which distribution correlates with creator selection.

**5. Input sanitization + output moderation.**
Strip prompt injection patterns from brief fields. Run generated framings through OpenAI's Moderation API before showing them to users.

---

## Where AI Doesn't Make Sense in This Flow

| Function | Why not AI |
|----------|-----------|
| Creator ranking | Too slow, expensive, non-deterministic — embeddings handle this better |
| Input validation | Deterministic rule — "is this field non-empty?" doesn't need a model |
| Session / cookie management | Pure bookkeeping, no language understanding needed |
| A/B variant assignment | Hash-based, must be deterministic per session |
| Analytics logging | Writing to an API endpoint, no generation needed |
| Error messages | Standard HTTP responses, not generated prose |
