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
 * DIMENSION EMBEDDINGS:
 * Beyond the full-profile vector, each creator also has three targeted vectors:
 *   - audience  — audienceInterests
 *   - values    — apparentValues + socialStances + identifiedCauses
 *   - tone      — engagementStyle tone + contentStyle
 *
 * These are used by the re-ranking step in lib/scoring.ts when the user
 * provides the corresponding optional assignment fields. All four creator
 * vectors are pre-computed by scripts/generate-embeddings.mjs and stored
 * in data/creator-embeddings.json. When the file is missing or the creator
 * doesn't have dimension vectors yet, the scorer falls back to the full-
 * profile similarity only.
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
 * Used for the base full-profile embedding.
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

/** Audience dimension — matched against assignment.targetAudience. */
export function creatorAudienceText(creator: Creator): string {
  return creator.analysis.audienceInterests.filter(Boolean).join(", ");
}

/** Values dimension — matched against assignment.values. */
export function creatorValuesText(creator: Creator): string {
  return [
    ...creator.analysis.apparentValues,
    ...creator.analysis.socialStances,
    ...creator.analysis.identifiedCauses,
  ].filter(Boolean).join(", ");
}

/** Tone dimension — matched against assignment.tone. */
export function creatorToneText(creator: Creator): string {
  return [
    ...creator.analysis.engagementStyle.tone,
    creator.analysis.engagementStyle.contentStyle,
  ].filter(Boolean).join(", ");
}

/**
 * Build the query text from an assignment brief.
 * All populated fields are joined so the embedding captures the full intent.
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
 * Exported so lib/scoring.ts can batch assignment dimension texts with the
 * base assignment embedding in a single API call.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
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
// Creator embedding cache
// ---------------------------------------------------------------------------

/**
 * All pre-computed vectors for one creator.
 *
 * full     — full-profile vector; always present.
 * audience — audienceInterests vector; null if the embedding file pre-dates
 *            dimension support (re-run generate-embeddings to populate).
 * values   — apparentValues + causes + stances vector.
 * tone     — engagementStyle tone + contentStyle vector.
 */
export interface CreatorVectors {
  full:     number[];
  audience: number[] | null;
  values:   number[] | null;
  tone:     number[] | null;
}

let creatorEmbeddingCache: Map<string, CreatorVectors> | null = null;

// ---------------------------------------------------------------------------
// Pre-computed embedding file types
// ---------------------------------------------------------------------------

interface EmbeddingEntry {
  /** ISO timestamp of when this creator's embedding was generated. */
  embeddedAt: string;
  /** Normalized full-profile vector. */
  vector: number[];
  /** Per-dimension vectors — present when generated by the updated script. */
  dimensions?: {
    audience?: number[];
    values?:   number[];
    tone?:     number[];
  };
}

interface EmbeddingFile {
  model: string;
  entries: Record<string, EmbeddingEntry>;
}

// ---------------------------------------------------------------------------
// File loader with per-creator staleness check
// ---------------------------------------------------------------------------

/**
 * Batch-embed 4 texts per creator (full + 3 dimensions) interleaved so one
 * API call handles all stale creators at once.
 */
async function embedCreatorBatch(
  creators: Creator[],
): Promise<CreatorVectors[]> {
  const texts: string[] = [];
  for (const c of creators) {
    texts.push(creatorToText(c));
    texts.push(creatorAudienceText(c));
    texts.push(creatorValuesText(c));
    texts.push(creatorToneText(c));
  }
  const vecs = await embedBatch(texts);
  return creators.map((_, i) => ({
    full:     vecs[i * 4],
    audience: vecs[i * 4 + 1],
    values:   vecs[i * 4 + 2],
    tone:     vecs[i * 4 + 3],
  }));
}

/**
 * Load pre-computed embeddings from data/creator-embeddings.json, refreshing
 * any creator whose updatedAt is newer than their embeddedAt.
 *
 * Returns null if the file is missing or uses a different model — the caller
 * falls back to a full API batch call in that case.
 *
 * Staleness refresh:
 *   - Stale creators are re-embedded in a single batch call (all 4 vectors).
 *   - The file is written back with fresh timestamps (dev only — production
 *     deployments are read-only; redeploy after running generate-embeddings).
 */
async function loadPrecomputedEmbeddings(): Promise<Map<string, CreatorVectors> | null> {
  const filePath = join(process.cwd(), "data", "creator-embeddings.json");

  let cached: EmbeddingFile;
  try {
    cached = JSON.parse(readFileSync(filePath, "utf-8")) as EmbeddingFile;
  } catch {
    return null;
  }

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
    if (!entry) return true;
    return new Date(creator.updatedAt) > new Date(entry.embeddedAt);
  });

  if (stale.length > 0) {
    console.log(
      `[embeddings] ${stale.length} creator(s) updated since last embedding — refreshing…`,
    );
    const freshVectors = await embedCreatorBatch(stale);
    const embeddedAt = new Date().toISOString();

    for (let i = 0; i < stale.length; i++) {
      cached.entries[stale[i].uniqueId] = {
        embeddedAt,
        vector: freshVectors[i].full,
        dimensions: {
          audience: freshVectors[i].audience ?? undefined,
          values:   freshVectors[i].values   ?? undefined,
          tone:     freshVectors[i].tone     ?? undefined,
        },
      };
    }

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

  // Warn once if dimension vectors are missing (old file format)
  const missingDimensions = ALL_CREATORS.filter(
    (c) => cached.entries[c.uniqueId] && !cached.entries[c.uniqueId].dimensions,
  );
  if (missingDimensions.length > 0 && process.env.NODE_ENV === "development") {
    console.warn(
      `[embeddings] ${missingDimensions.length} creator(s) are missing dimension vectors. ` +
        "Re-run: npm run generate-embeddings",
    );
  }

  const map = new Map<string, CreatorVectors>(
    Object.entries(cached.entries).map(([id, entry]) => [
      id,
      {
        full:     entry.vector,
        audience: entry.dimensions?.audience ?? null,
        values:   entry.dimensions?.values   ?? null,
        tone:     entry.dimensions?.tone     ?? null,
      },
    ]),
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
 *   3. OpenAI full batch API call — only if the file is missing or uses a
 *      different model (e.g. first-time setup before generate-embeddings is run)
 */
export async function getCreatorEmbeddings(): Promise<Map<string, CreatorVectors>> {
  if (creatorEmbeddingCache) return creatorEmbeddingCache;

  const fromFile = await loadPrecomputedEmbeddings();
  if (fromFile) {
    creatorEmbeddingCache = fromFile;
    return creatorEmbeddingCache;
  }

  if (process.env.NODE_ENV === "development") {
    console.log(
      "[embeddings] No usable pre-computed file — calling OpenAI for all creators. " +
        "Run `npm run generate-embeddings` to cache these.",
    );
  }

  const freshVectors = await embedCreatorBatch(ALL_CREATORS);
  creatorEmbeddingCache = new Map(
    ALL_CREATORS.map((creator, i) => [creator.uniqueId, freshVectors[i]]),
  );

  return creatorEmbeddingCache;
}
