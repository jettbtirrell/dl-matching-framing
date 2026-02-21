/**
 * Multi-signal creator scoring — the heart of the matching algorithm.
 *
 * SCORING PIPELINE
 * ────────────────
 * Every creator receives a combined score built from up to five signals:
 *
 *   1. semantic (always active)
 *      Full-profile embedding cosine similarity — captures overall thematic
 *      alignment between the assignment and the creator's entire profile.
 *
 *   2. audience (active when assignment.targetAudience is provided)
 *      Embedding similarity between the stated target audience and the
 *      creator's audienceInterests dimension vector.
 *
 *   3. values (active when assignment.values is provided)
 *      Embedding similarity between desired creator values and the creator's
 *      apparentValues + socialStances + identifiedCauses dimension vector.
 *
 *   4. tone (active when assignment.tone is provided)
 *      Embedding similarity between desired tone and the creator's
 *      engagementStyle tone + contentStyle dimension vector.
 *
 *   5. engagement (always active)
 *      Normalized engagement rate: heartCount / (followerCount × 5), clamped
 *      to [0, 1]. A creator with 5× their follower count in total hearts
 *      scores 1.0. Pure math — no API call required.
 *
 * COMBINATION
 * ───────────
 * Signals are combined as a weighted average. Weights are read from
 * config.matching.dimensionWeights and normalized by the sum of *active*
 * weights — so filling in optional fields shifts weight toward those
 * targeted dimensions rather than simply adding bonus points.
 *
 * GEOGRAPHIC PENALTY
 * ──────────────────
 * Non-US creators' combined scores are multiplied by config.matching.nonUSPenalty
 * (default 0.2) after combination. Assignments are US-focused by default.
 *
 * BATCHING
 * ────────
 * All assignment texts (base + up to 3 optional dimension texts) are embedded
 * in a single OpenAI batch call, keeping request count at 1 regardless of how
 * many optional fields the user fills in.
 *
 * LATENCY PROFILE
 * ───────────────
 * - First request: ~150ms creator embeddings (cached after first call) +
 *   ~100ms for the batched assignment embeddings.
 * - Subsequent requests: ~100ms for the assignment batch only.
 * - Claude framing still dominates at 2–4s, so scoring overhead is invisible.
 */

import creatorsData from "@/data/creators.json";
import type { Assignment, Creator, ScoredCreator } from "@/types";
import { config } from "@/lib/config";
import {
  assignmentToText,
  cosineSimilarity,
  embedBatch,
  getCreatorEmbeddings,
} from "@/lib/embeddings";

const ALL_CREATORS = Object.values(creatorsData) as Creator[];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Score all creators against the assignment, apply the non-US penalty,
 * sort descending, and return the top N.
 *
 * All assignment embeddings (base + optional dimensions) are fetched in one
 * batch call. Creator embeddings are loaded from the module-level cache.
 */
export async function getTopCreators(
  assignment: Assignment,
): Promise<ScoredCreator[]> {
  // ── Build the batch of assignment texts to embed ──────────────────────────
  // Index 0 is always the full-profile query. Optional dimension texts are
  // appended when the user has filled in the corresponding field.
  const assignmentTexts: string[] = [assignmentToText(assignment)];
  const dimIdx: { audience?: number; values?: number; tone?: number } = {};

  if (assignment.targetAudience?.trim()) {
    dimIdx.audience = assignmentTexts.length;
    assignmentTexts.push(assignment.targetAudience.trim());
  }
  if (assignment.values?.trim()) {
    dimIdx.values = assignmentTexts.length;
    assignmentTexts.push(assignment.values.trim());
  }
  if (assignment.tone?.trim()) {
    dimIdx.tone = assignmentTexts.length;
    assignmentTexts.push(assignment.tone.trim());
  }

  // ── Embed assignment + fetch creator cache in parallel ────────────────────
  const [assignmentVecs, creatorEmbeddings] = await Promise.all([
    embedBatch(assignmentTexts),
    getCreatorEmbeddings(),
  ]);

  const baseVec     = assignmentVecs[0];
  const audienceVec = dimIdx.audience !== undefined ? assignmentVecs[dimIdx.audience] : null;
  const valuesVec   = dimIdx.values   !== undefined ? assignmentVecs[dimIdx.values]   : null;
  const toneVec     = dimIdx.tone     !== undefined ? assignmentVecs[dimIdx.tone]     : null;

  const w = config.matching.dimensionWeights;

  // ── Score every creator ───────────────────────────────────────────────────
  const scored = ALL_CREATORS.map((creator): ScoredCreator => {
    const embedding = creatorEmbeddings.get(creator.uniqueId);
    if (!embedding) {
      throw new Error(`Missing embedding for creator: ${creator.uniqueId}`);
    }

    // Signal 1: full-profile semantic similarity (always active)
    const semanticScore = Math.max(0, cosineSimilarity(baseVec, embedding.full));

    // Signal 2–4: dimension similarities (active only when both the assignment
    // field and the creator's dimension vector are available)
    const audienceScore =
      audienceVec && embedding.audience
        ? Math.max(0, cosineSimilarity(audienceVec, embedding.audience))
        : null;
    const valuesScore =
      valuesVec && embedding.values
        ? Math.max(0, cosineSimilarity(valuesVec, embedding.values))
        : null;
    const toneScore =
      toneVec && embedding.tone
        ? Math.max(0, cosineSimilarity(toneVec, embedding.tone))
        : null;

    // Signal 5: engagement rate — heartCount / (followerCount × 5), clamped [0,1]
    // A creator with 5× their follower count in total hearts scores 1.0.
    const engagementScore = Math.min(
      1,
      creator.heartCount / Math.max(1, creator.followerCount * 5),
    );

    // ── Weighted combination ──────────────────────────────────────────────
    // Only active signals contribute weight, so the score stays in [0, 1]
    // and optional fields shift weight rather than add bonus points.
    let score       = w.semantic * semanticScore + w.engagement * engagementScore;
    let totalWeight = w.semantic + w.engagement;

    if (audienceScore !== null) { score += w.audience * audienceScore; totalWeight += w.audience; }
    if (valuesScore   !== null) { score += w.values   * valuesScore;   totalWeight += w.values;   }
    if (toneScore     !== null) { score += w.tone     * toneScore;     totalWeight += w.tone;     }

    score /= totalWeight; // normalise to [0, 1]

    // Geographic penalty applied after combination
    if (creator.region !== "US") {
      score *= config.matching.nonUSPenalty;
    }

    if (process.env.NODE_ENV === "development") {
      const dims = [
        audienceScore !== null ? ` audience=${audienceScore.toFixed(3)}` : "",
        valuesScore   !== null ? ` values=${valuesScore.toFixed(3)}`     : "",
        toneScore     !== null ? ` tone=${toneScore.toFixed(3)}`         : "",
      ].join("");
      console.log(
        `[scoring] ${creator.uniqueId.padEnd(22)} ` +
          `final=${score.toFixed(4)} semantic=${semanticScore.toFixed(3)} ` +
          `engagement=${engagementScore.toFixed(3)}${dims} region=${creator.region}`,
      );
    }

    return { creator, score };
  });

  // Sort highest score first, take topN
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, config.matching.topN);
}
