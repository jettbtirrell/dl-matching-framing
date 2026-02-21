/**
 * Semantic creator scoring — the heart of the matching algorithm.
 *
 * ARCHITECTURAL CHOICE: Embedding-based cosine similarity, not keyword matching.
 *
 * The previous version used weighted keyword overlap across five dimensions
 * (niche, values, tone, audience, causes). That approach is auditable and fast
 * but misses semantic connections: "consumer awareness" and "economic anxiety"
 * are strongly related ideas with no shared substrings, so keyword matching
 * would score them as unrelated.
 *
 * Embedding-based similarity captures *meaning*. The assignment brief and each
 * creator profile are independently embedded into a high-dimensional vector
 * space, then ranked by cosine similarity. Creators whose overall profile is
 * semantically close to the assignment rank highest — regardless of whether
 * any specific keyword matches.
 *
 * WHAT'S PRESERVED FROM THE PREVIOUS VERSION:
 * - Non-US penalty: non-US creators' scores are multiplied by 0.2 (80% reduction).
 *   Drumbeat assignments are US-focused. Geographic fit is a hard constraint
 *   that semantic similarity alone can't capture.
 * - Top-3 selection: we still return the 3 best-scoring creators.
 * - Dev-mode logging: console.log shows similarity scores so you can inspect
 *   the full ranking.
 *
 * LATENCY PROFILE:
 * - First request: ~150ms to batch-embed 16 creators + ~100ms to embed the
 *   assignment = ~250ms total embedding time, then the cached creator vectors
 *   are reused for all subsequent requests.
 * - Subsequent requests: ~100ms to embed the assignment only (creator cache hit).
 * - Claude framing still dominates at 2–4s, so the embedding overhead is not
 *   visible to the user.
 */

import creatorsData from "@/data/creators.json";
import type { Assignment, Creator, ScoredCreator } from "@/types";
import {
  assignmentToText,
  cosineSimilarity,
  embed,
  getCreatorEmbeddings,
} from "@/lib/embeddings";

// The JSON is an object keyed by uniqueId — we need Object.values() to iterate.
const ALL_CREATORS = Object.values(creatorsData) as Creator[];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Embed the assignment brief, fetch cached creator embeddings, compute cosine
 * similarity for each creator, apply the non-US penalty, sort descending,
 * and return the top 3.
 *
 * The creator embedding cache is populated on the first call (one batch API
 * request for all creators) and reused on every subsequent call.
 *
 * Console logs in development show every creator's similarity score and region
 * so you can inspect why specific creators ranked where they did.
 */
export async function getTopCreators(
  assignment: Assignment,
): Promise<ScoredCreator[]> {
  // Kick off both calls in parallel:
  //   - embed the assignment brief (always a network call, ~100ms)
  //   - fetch creator embeddings (cached after first request)
  const [assignmentVec, creatorEmbeddings] = await Promise.all([
    embed(assignmentToText(assignment)),
    getCreatorEmbeddings(),
  ]);

  const scored = ALL_CREATORS.map((creator) => {
    const creatorVec = creatorEmbeddings.get(creator.uniqueId);
    if (!creatorVec) {
      throw new Error(`Missing embedding for creator: ${creator.uniqueId}`);
    }

    // Cosine similarity is in [-1, 1] for arbitrary vectors; in practice
    // text embeddings stay positive, but clamp at 0 to be safe.
    let score = Math.max(0, cosineSimilarity(assignmentVec, creatorVec));

    // Non-US penalty — see module-level comment for rationale.
    // We multiply rather than subtract so the penalty scales proportionally
    // with the creator's raw score.
    if (creator.region !== "US") {
      score = score * 0.2;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[scoring] ${creator.uniqueId.padEnd(22)} ` +
          `similarity=${score.toFixed(4)} region=${creator.region}`,
      );
    }

    return { creator, score };
  });

  // Sort highest score first, take top 3
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}
