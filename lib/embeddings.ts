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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import creatorsData from "@/data/creators.json";
import type { Assignment, Creator } from "@/types";
import { config } from "@/lib/config";

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
      model: config.embeddings.model,
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
 * Module-level cache populated on the first getCreatorEmbeddings() call.
 *
 * null  = not yet loaded
 * Map   = populated, reused on every subsequent request in this process
 *
 * Load priority:
 *   1. This in-memory Map (fastest — zero I/O after first call)
 *   2. data/creator-embeddings.json (fast — disk read, no API call)
 *      Generated by: npm run generate-embeddings
 *   3. OpenAI batch API call (slow — ~150ms, only on first cold start
 *      if the pre-computed file is missing or uses a different model)
 */
let creatorEmbeddingCache: Map<string, number[]> | null = null;

// ---------------------------------------------------------------------------
// Pre-computed embedding file types
// ---------------------------------------------------------------------------

interface EmbeddingEntry {
  /** ISO timestamp of when this creator's embedding was generated. */
  embeddedAt: string;
  /** Normalized 1536-dimensional vector. */
  vector: number[];
}

interface EmbeddingFile {
  model: string;
  entries: Record<string, EmbeddingEntry>;
}

// ---------------------------------------------------------------------------
// File loader with per-creator staleness check
// ---------------------------------------------------------------------------

/**
 * Load pre-computed embeddings from data/creator-embeddings.json, refreshing
 * any creator whose updatedAt is newer than their embeddedAt.
 *
 * Returns null if the file is missing or uses a different model — the caller
 * falls back to a full API batch call in that case.
 *
 * Staleness refresh:
 *   - Stale creators are re-embedded in a single batch call.
 *   - The file is written back with fresh timestamps (dev only — production
 *     deployments are read-only; redeploy after running generate-embeddings).
 */
async function loadPrecomputedEmbeddings(): Promise<Map<string, number[]> | null> {
  const filePath = join(process.cwd(), "data", "creator-embeddings.json");

  let cached: EmbeddingFile;
  try {
    cached = JSON.parse(readFileSync(filePath, "utf-8")) as EmbeddingFile;
  } catch {
    // File doesn't exist yet — caller will fall back to full API batch
    return null;
  }

  // Reject files generated with a different model
  if (!cached.entries || cached.model !== config.embeddings.model) {
    console.warn(
      `[embeddings] Pre-computed file uses model "${cached.model}" but ` +
        `config wants "${config.embeddings.model}". Re-run: npm run generate-embeddings`,
    );
    return null;
  }

  // Find creators whose profile was updated after their embedding was generated
  const stale = ALL_CREATORS.filter((creator) => {
    const entry = cached.entries[creator.uniqueId];
    if (!entry) return true; // creator is missing from the file entirely
    return new Date(creator.updatedAt) > new Date(entry.embeddedAt);
  });

  if (stale.length > 0) {
    console.log(
      `[embeddings] ${stale.length} creator(s) updated since last embedding — refreshing…`,
    );
    const freshVectors = await embedBatch(stale.map(creatorToText));
    const embeddedAt = new Date().toISOString();

    for (let i = 0; i < stale.length; i++) {
      cached.entries[stale[i].uniqueId] = {
        embeddedAt,
        vector: freshVectors[i],
      };
    }

    // Write back only in development — production deployments are read-only.
    // To persist refreshed embeddings to production: re-run generate-embeddings
    // and redeploy.
    if (process.env.NODE_ENV !== "production") {
      try {
        writeFileSync(filePath, JSON.stringify(cached, null, 2), "utf-8");
        console.log(
          `[embeddings] Wrote ${stale.length} refreshed embedding(s) back to file.`,
        );
      } catch (err) {
        console.warn("[embeddings] Could not write back to file:", err);
      }
    }
  }

  const map = new Map(
    Object.entries(cached.entries).map(([id, entry]) => [id, entry.vector]),
  );

  if (process.env.NODE_ENV === "development") {
    console.log(
      `[embeddings] Loaded ${map.size} embeddings from file` +
        (stale.length > 0 ? ` (${stale.length} refreshed)` : " (all current)"),
    );
  }

  return map;
}

/**
 * Return the creator embedding cache, loading it on the first call.
 *
 * Load priority:
 *   1. In-memory Map  — zero cost after first call in this process
 *   2. data/creator-embeddings.json — disk read + staleness check, no full API call
 *      (stale individual creators are re-embedded in a targeted batch)
 *   3. OpenAI full batch API call — only if the file is missing or uses a
 *      different model (e.g. first-time setup before generate-embeddings is run)
 */
export async function getCreatorEmbeddings(): Promise<Map<string, number[]>> {
  if (creatorEmbeddingCache) return creatorEmbeddingCache;

  // Try the pre-computed file (with per-creator staleness check)
  const fromFile = await loadPrecomputedEmbeddings();
  if (fromFile) {
    creatorEmbeddingCache = fromFile;
    return creatorEmbeddingCache;
  }

  // Full batch fallback — file missing or model changed
  if (process.env.NODE_ENV === "development") {
    console.log(
      "[embeddings] No usable pre-computed file — calling OpenAI for all creators. " +
        "Run `npm run generate-embeddings` to cache these.",
    );
  }
  const texts = ALL_CREATORS.map(creatorToText);
  const vectors = await embedBatch(texts);

  creatorEmbeddingCache = new Map(
    ALL_CREATORS.map((creator, i) => [creator.uniqueId, vectors[i]]),
  );

  return creatorEmbeddingCache;
}
