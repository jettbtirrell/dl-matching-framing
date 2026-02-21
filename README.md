# dl-matching-framing

An internal tool that matches nonprofit campaign briefs to TikTok creators using semantic embeddings, then generates personalized post framings via Claude Haiku.

---

## Architecture

![Architecture](architecture.png)

> To regenerate: `npm run export-diagram` (requires draw.io desktop CLI on PATH), or open `architecture.drawio` directly in draw.io or VS Code with the Draw.io extension.

---

## Quick Start

```bash
npm install
```

Create `.env.local`:
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
POSTHOG_API_KEY=phc_...              # Server-side events — omit to fall back to console.log
POSTHOG_HOST=https://app.posthog.com # Server-side host (default: app.posthog.com)
NEXT_PUBLIC_POSTHOG_KEY=phc_...      # Client-side page views (same value as POSTHOG_API_KEY)
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com  # Client-side host
```

Pre-compute creator embeddings (run once; commit the output):
```bash
npm run generate-embeddings
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## What AI Is Used For (and Why)

**Two AI calls per request — nothing more.**

| Step | Technology | Why AI |
|------|-----------|--------|
| Ranking creators | OpenAI `text-embedding-3-small` | Semantic similarity catches related concepts keyword search misses — "consumer awareness" ↔ "economic anxiety" share no words but sit close in embedding space |
| Writing framings | Claude Haiku (gpt-4o-mini fallback) | Natural language tailored to each creator's style and audience can't be produced deterministically |

**Where AI is explicitly not used:** routing, session management, A/B variant assignment, input validation, form rendering, analytics logging. These are deterministic problems. Using AI for them adds cost and nondeterminism without adding value.

---

## Matching Approach

The brief and each creator profile are embedded as vectors. Creators are ranked by a weighted combination of five signals:

| Signal | Weight | Active when |
|--------|--------|-------------|
| `semantic` | 60% | Always — full-profile cosine similarity |
| `audience` | 15% | `targetAudience` field is filled |
| `values` | 15% | `values` field is filled |
| `tone` | 5% | `tone` field is filled |
| `engagement` | 5% | Always — heart/follower ratio |

Filling optional fields shifts weight toward those targeted dimensions rather than adding bonus points — scores stay comparable across submissions. All weights are tunable in `lib/config.ts` without touching the algorithm.

Creator embeddings are pre-computed and committed. Runtime cost is one embedding call for the assignment (~100ms, ~$0.00002).

---

## UX Decisions

**Speed of first result.** Creator cards appear within ~200ms of submitting, before the LLM has written anything. The user reads real content (name, bio, niches, follower count) while Claude runs in the background.

**Progressive disclosure.** Required fields (topic, takeaway, context) in the main card. Optional fields in a separate card below with a "More detail = more precise matching" hint. A first-time user submits a valid brief without reading documentation.

**Results that explain themselves.** "Why they match" in 1–3 sentences references the creator's actual niche, tone, or audience — not generic praise. "Suggested Post Framing" is a concrete content concept, not vague guidance. The Top Match badge and indigo border nudge without mandating.

---

## Model and Provider Choices

| Model | Role | Rationale |
|-------|------|-----------|
| `text-embedding-3-small` | Semantic matching | Fast (~100ms), cheap (~$0.02/MTok), 1536D — sufficient for short creator profiles |
| `claude-haiku-4-5-20251001` | Framing generation | $0.25/$1.25 per MTok in/out, 2–4s latency, good structured output quality |
| `gpt-4o-mini` | Automatic fallback | Same price range, different infrastructure — real redundancy, not a retry |

Claude Sonnet and GPT-4o produce marginally better framings at 5–12× the cost and latency. Prompt engineering matters more than raw model capability for this structured generation task.

---

## What's Next (1–2 Weeks)

1. **Stream LLM tokens word-by-word** — framings appear as they're typed; eliminates the shimmer wait entirely
2. **Track creator selection** — log which creator the user acts on, not just which are surfaced; drives empirical weight tuning
3. **Structured output mode** — guaranteed-schema JSON from Claude and OpenAI eliminates the parse-failure → fallback path
4. **Tune dimension weights** — once selection data exists, experiment with weights in `config.matching.dimensionWeights` and measure against click-through
5. **Input sanitization + output moderation** — strip prompt injection patterns, run framings through OpenAI Moderation API before display

---

## Docs

| Document | Audience | What's in it |
|----------|----------|-------------|
| [PLANNING.md](PLANNING.md) | Product / stakeholders | Questions faced, options considered, decisions made, and reasoning — the "why" behind each choice |
| [ENGINEERING.md](ENGINEERING.md) | Engineers | API contracts, module responsibilities, configuration reference, how to add creators, Datadog setup, hardening path |
| [CLAUDE.md](CLAUDE.md) | Claude Code | Dev commands, key files, common tasks, coding rules, where not to use AI |
