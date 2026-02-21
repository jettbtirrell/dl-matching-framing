/**
 * Semantic embedding utilities for creator matching.
 *
 * WHY EMBEDDINGS INSTEAD OF KEYWORD SCORING?
 * The keyword scorer in the previous version catches "personal finance" ↔
 * "Financial Literacy" (shared substring), but misses semantically related
 * concepts like "consumer awareness" ↔ "economic anxiety" — no shared words,
 * but the same idea. Embedding-based cosine similarity handles both because it
 * encodes *meaning*, not just string overlap.
 *
 * MODEL CHOICE: OpenAI text-embedding-3-small
 * - Fast: < 200ms for a batch of 16 creators
 * - Cheap: ~$0.02 per million tokens
 * - 1536-dimensional output: enough resolution for short creator profiles
 * - No new npm package: plain fetch works for a single HTTP endpoint
 *
 * CREATOR EMBEDDING CACHE:
 * Creator profiles don't change between requests. We batch-embed all creators
 * on the first request and store the vectors at module scope. Every subsequent
 * request skips the batch call and only embeds the assignment (~100ms).
 *
 * In development, the cache survives Next.js hot reloads because Node.js
 * module caches persist across HMR cycles (the module is not re-evaluated).
 */

import creatorsData from "@/data/creators.json";
import type { Assignment, Creator } from "@/types";

const ALL_CREATORS = Object.values(creatorsData) as Creator[];

// ---------------------------------------------------------------------------
// Text serialization — convert structured objects to embedding-friendly strings
// ---------------------------------------------------------------------------

/**
 * Build a single text string that captures everything meaningful about a creator.
 * More semantic content → richer embedding → better recall on varied queries.
 *
 * Format mirrors what a human analyst would write as a "creator brief":
 * name, what they're about, niche categories, values, communication style,
 * audience characteristics, and any cause alignment.
 */
function creatorToText(creator: Creator): string {
  const { analysis } = creator;
  return [
    `Creator: @${creator.uniqueId}`,
    `Summary: ${analysis.summary}`,
    `Primary niches: ${analysis.primaryNiches.join(", ")}`,
    `Secondary niches: ${analysis.secondaryNiches.join(", ")}`,
    `Values: ${analysis.apparentValues.join(", ")}`,
    `Tone: ${analysis.engagementStyle.tone.join(", ")}`,
    `Audience interests: ${analysis.audienceInterests.join(", ")}`,
    `Causes: ${analysis.identifiedCauses.join(", ")}`,
  ].join("\n");
}

/**
 * Build the query text from an assignment brief.
 * All populated fields are joined so the embedding captures the full intent —
 * topic, takeaway, context, audience, values, niches, and tone all contribute.
 */
export function assignmentToText(assignment: Assignment): string {
  return [
    assignment.topic,
    assignment.keyTakeaway,
    assignment.context,
    assignment.targetAudience,
    assignment.values,
    assignment.niches,
    assignment.tone,
  ]
    .filter(Boolean)
    .join(". ");
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Normalize a vector to unit length (L2 norm = 1).
 * We normalize once at embed time so cosine similarity reduces to a cheap
 * dot product (no repeated magnitude calculations per pair).
 */
function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

/**
 * Cosine similarity between two pre-normalized (unit) vectors.
 * Range is [-1, 1]; for text embeddings it's effectively [0, 1].
 * Computed as a plain dot product since both vectors are already normalized.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

// ---------------------------------------------------------------------------
// OpenAI embeddings API
// ---------------------------------------------------------------------------

/**
 * Call the OpenAI embeddings API for a batch of texts in one round-trip.
 * Returns normalized vectors in the same order as the input.
 */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to guarantee input order (API typically preserves it,
  // but the spec doesn't guarantee it for large batches)
  const ordered = json.data.sort((a, b) => a.index - b.index);
  return ordered.map((d) => normalize(d.embedding));
}

/**
 * Embed a single text string and return the normalized vector.
 */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}

// ---------------------------------------------------------------------------
// Lazy creator embedding cache
// ---------------------------------------------------------------------------

/**
 * Module-level cache populated on the first getTopCreators() call.
 *
 * null  = not yet computed
 * Map   = populated, reused on every subsequent request
 *
 * The cache maps uniqueId → normalized embedding vector. Storing by uniqueId
 * (not array index) makes lookup O(1) and safe if the creators array order
 * ever changes.
 */
let creatorEmbeddingCache: Map<string, number[]> | null = null;

/**
 * Return the creator embedding cache, computing it on the first call.
 * All 16 creators are embedded in a single batch request (~150ms).
 * Subsequent calls return the cached Map immediately.
 */
export async function getCreatorEmbeddings(): Promise<Map<string, number[]>> {
  if (creatorEmbeddingCache) return creatorEmbeddingCache;

  const texts = ALL_CREATORS.map(creatorToText);
  const embeddings = await embedBatch(texts);

  creatorEmbeddingCache = new Map(
    ALL_CREATORS.map((creator, i) => [creator.uniqueId, embeddings[i]]),
  );

  if (process.env.NODE_ENV === "development") {
    console.log(
      `[embeddings] Cached embeddings for ${creatorEmbeddingCache.size} creators`,
    );
  }

  return creatorEmbeddingCache;
}
