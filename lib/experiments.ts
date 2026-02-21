/**
 * A/B testing experiment framework.
 *
 * DESIGN PRINCIPLES:
 * - Stateless: variant assignment is a pure function of (sessionId, experiment).
 *   No database, no external service. The same session always gets the same
 *   variant as long as the experiment config doesn't change.
 * - Deterministic: uses a stable hash so assignment is reproducible and testable.
 * - Zero-latency: no network calls, just arithmetic.
 *
 * HOW TO ADD A NEW EXPERIMENT:
 *   1. Add an entry to EXPERIMENTS below with a unique name, variants, and weights.
 *   2. Set enabled: true when you're ready to start collecting data.
 *   3. Read the variant in the route: getVariant(sessionId, "your_experiment")
 *   4. Implement the variant behavior in the relevant file/component.
 *   5. The variant is included in every logged event under data.variants —
 *      filter logs/events.jsonl to compare outcomes across variants.
 *
 * HOW TO STOP AN EXPERIMENT:
 *   Set enabled: false. All sessions will return variants[0] (the control).
 *   Keep the config entry so old log entries remain interpretable.
 *
 * ANALYZING RESULTS:
 *   jq 'select(.event == "match_completed" and .data.variants.llm_provider == "openai")' \
 *     logs/events.jsonl
 */

export interface ExperimentConfig {
  name: string;
  variants: string[];
  /**
   * Traffic split. weights[i] is the fraction of sessions assigned to variants[i].
   * Must sum to 1.0. e.g. [0.8, 0.2] = 80% control, 20% variant.
   */
  weights: number[];
  /**
   * When false, always returns variants[0] (control) regardless of sessionId.
   * Toggle to pause/resume an experiment without removing code.
   */
  enabled: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Active experiments
// ---------------------------------------------------------------------------

export const EXPERIMENTS: ExperimentConfig[] = [
  {
    name: "llm_provider",
    variants: ["claude", "openai"],
    weights: [0.8, 0.2], // 80% Claude Haiku, 20% OpenAI gpt-4o-mini
    enabled: false,
    description:
      "Test gpt-4o-mini as a primary framing provider against Claude Haiku. " +
      "Measures whether OpenAI produces meaningfully different framing quality.",
  },
  {
    name: "ui_creator_summary",
    variants: ["show", "hide"],
    weights: [0.5, 0.5],
    enabled: false,
    description:
      "Show or hide the creator bio summary in loading cards during the framing phase. " +
      "Measures whether the extra context while loading affects engagement.",
  },
  {
    name: "scoring_approach",
    variants: ["embeddings"],
    weights: [1.0],
    enabled: false,
    description:
      "Placeholder for testing alternative ranking approaches. " +
      "Add variants and update lib/scoring.ts to implement alternatives.",
  },
];

// ---------------------------------------------------------------------------
// Variant assignment — deterministic hash
// ---------------------------------------------------------------------------

/**
 * Stable 32-bit hash of an arbitrary string (djb2 variant, unsigned output).
 * Same input always → same output. No randomness involved.
 */
function stableHash(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // Bitwise XOR with char code, keep as unsigned 32-bit integer
    hash = (((hash << 5) + hash) ^ input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Map a session+experiment pair to a variant using the experiment's weights.
 *
 * The hash is normalized to [0, 1) and compared against cumulative weight
 * buckets. Because the hash is stable, the same session always lands in the
 * same bucket — the assignment is permanent for the session's lifetime.
 *
 * Example with weights [0.8, 0.2]:
 *   hash → position 0.72 → bucket [0.00, 0.80) → variants[0]
 *   hash → position 0.91 → bucket [0.80, 1.00) → variants[1]
 */
export function assignVariant(
  sessionId: string,
  experiment: ExperimentConfig,
): string {
  const hash = stableHash(`${sessionId}:${experiment.name}`);
  // Normalize to [0, 1). We divide by 0xffffffff (max uint32) + 1 to get
  // a value that's always strictly less than 1.
  const position = hash / (0xffffffff + 1);

  let cumulative = 0;
  for (let i = 0; i < experiment.weights.length; i++) {
    cumulative += experiment.weights[i];
    if (position < cumulative) return experiment.variants[i];
  }
  // Fallback (floating-point rounding guard)
  return experiment.variants[experiment.variants.length - 1];
}

/**
 * Get the assigned variant for a named experiment.
 * Returns variants[0] (control) when the experiment is disabled or unknown.
 */
export function getVariant(sessionId: string, experimentName: string): string {
  const experiment = EXPERIMENTS.find((e) => e.name === experimentName);
  if (!experiment || !experiment.enabled) {
    return experiment?.variants[0] ?? "control";
  }
  return assignVariant(sessionId, experiment);
}

/**
 * Returns true if the named experiment is currently active.
 * Use this to decide whether to read getVariant() or fall back to config defaults.
 */
export function isExperimentEnabled(name: string): boolean {
  return EXPERIMENTS.find((e) => e.name === name)?.enabled ?? false;
}

/**
 * Get all experiment variant assignments for a session in one call.
 * Included in every analytics event so you can always filter by variant.
 */
export function getAllVariants(sessionId: string): Record<string, string> {
  return Object.fromEntries(
    EXPERIMENTS.map((exp) => [exp.name, getVariant(sessionId, exp.name)]),
  );
}
