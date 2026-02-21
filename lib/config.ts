/**
 * Central application configuration.
 *
 * Edit SETTINGS below to tune the app's behavior — models, scoring, and UI.
 * All fields are optional; anything omitted falls back to DEFAULTS.
 *
 * Common changes:
 *
 *   Switch the default LLM to OpenAI:
 *     llm: { defaultProvider: "openai" }
 *
 *   Show 5 results instead of 3:
 *     matching: { topN: 5 }
 *
 *   Enable geographic filtering (50% score reduction for non-US creators):
 *     matching: { nonUSPenalty: 0.5 }
 *     Default is 1.0 (no penalty). Set lower to down-rank non-US creators.
 *
 *   Use a larger (slower, more accurate) embedding model:
 *     embeddings: { model: "text-embedding-3-large" }
 *     Restart the dev server after changing — the creator cache must rebuild.
 *
 *   Add a new LLM provider:
 *     1. Add an entry to the providers block in SETTINGS (or DEFAULTS).
 *     2. Handle the new key in lib/claude.ts.
 *     3. Optionally add it as a variant in lib/experiments.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSettings {
  /** Model identifier sent to the API. */
  model: string;
  /** Maximum tokens the model may output per framing call. */
  maxTokens: number;
}

export interface AppConfig {
  llm: {
    /** Which LLM to use when no A/B experiment overrides the session. */
    defaultProvider: LLMProviderName;
    providers: {
      claude: ProviderSettings;
      openai: ProviderSettings;
    };
  };
  embeddings: {
    /** OpenAI embedding model for creator + assignment vectors. */
    model: string;
  };
  matching: {
    /** How many top creators to return and display. */
    topN: number;
    /**
     * Score multiplier for non-US creators (0–1).
     * 0.2 = 80% reduction.  1.0 = no penalty.
     */
    nonUSPenalty: number;
    /**
     * Relative weights for each scoring dimension.
     * Weights are normalized at runtime — they don't need to sum to 1.
     * Set a weight to 0 to disable that dimension entirely.
     *
     * Dimension signals:
     *   semantic   — full-profile embedding cosine similarity (always active)
     *   audience   — assignment targetAudience ↔ creator audienceInterests
     *                (active only when the user fills the targetAudience field)
     *   values     — assignment values ↔ creator apparentValues + causes + stances
     *                (active only when the user fills the values field)
     *   tone       — assignment tone ↔ creator engagementStyle tone + contentStyle
     *                (active only when the user fills the tone field)
     *   engagement — heartCount / followerCount signal; no API call required
     *                (always active)
     */
    dimensionWeights: {
      semantic:   number;
      audience:   number;
      values:     number;
      tone:       number;
      engagement: number;
    };
  };
  ui: {
    /** Max niche tags shown per creator card (combined primary + secondary). */
    maxNichesPerCard: number;
    /** Character limits for all assignment form fields. */
    maxChars: {
      /** Assignment topic — short, one-line field. */
      topic: number;
      /** Key takeaway — medium, two-line field. */
      keyTakeaway: number;
      /** Additional context — large, free-text field. */
      context: number;
      /** Optional: target audience description. */
      targetAudience: number;
      /** Optional: desired creator values. */
      values: number;
      /** Optional: desired tone / style. */
      tone: number;
    };
  };
}

export type LLMProviderName = keyof AppConfig["llm"]["providers"];

// ---------------------------------------------------------------------------
// Defaults — safe baseline values. Do not remove entries.
// ---------------------------------------------------------------------------

const DEFAULTS: AppConfig = {
  llm: {
    defaultProvider: "claude",
    providers: {
      claude: { model: "claude-haiku-4-5-20251001", maxTokens: 2500 },
      openai: { model: "gpt-4o-mini",               maxTokens: 2500 },
    },
  },
  embeddings: { model: "text-embedding-3-small" },
  matching: {
    topN: 3,
    nonUSPenalty: 1.0,
    dimensionWeights: { semantic: 0.60, audience: 0.15, values: 0.15, tone: 0.05, engagement: 0.05 },
  },
  ui: {
    maxNichesPerCard: 4,
    maxChars: { topic: 150, keyTakeaway: 500, context: 3000, targetAudience: 300, values: 200, tone: 200 },
  },
};

// ---------------------------------------------------------------------------
// SETTINGS — edit here. All fields are optional.
// Anything omitted falls back to DEFAULTS above.
// ---------------------------------------------------------------------------

interface Settings {
  llm?: {
    defaultProvider?: LLMProviderName;
    providers?: {
      claude?: Partial<ProviderSettings>;
      openai?:  Partial<ProviderSettings>;
    };
  };
  embeddings?: { model?: string };
  matching?: {
    topN?: number;
    nonUSPenalty?: number;
    dimensionWeights?: { semantic?: number; audience?: number; values?: number; tone?: number; engagement?: number };
  };
  ui?: {
    maxNichesPerCard?: number;
    maxChars?: { topic?: number; keyTakeaway?: number; context?: number; targetAudience?: number; values?: number; tone?: number };
  };
}

const SETTINGS: Settings = {
  // Uncomment and edit any line to override a default:

  // llm:        { defaultProvider: "openai" },
  // matching:   { topN: 5, nonUSPenalty: 1.0, dimensionWeights: { semantic: 0.5, audience: 0.2, values: 0.2, tone: 0.05, engagement: 0.05 } },
  // embeddings: { model: "text-embedding-3-large" },
  // ui:         { maxNichesPerCard: 6, maxChars: { topic: 200, keyTakeaway: 600, context: 5000 } },
};

// ---------------------------------------------------------------------------
// Resolved config — merges SETTINGS over DEFAULTS with safety clamping.
// Consuming files import this; they do not need fallback logic of their own.
// ---------------------------------------------------------------------------

export const config: AppConfig = {
  llm: {
    defaultProvider:
      SETTINGS.llm?.defaultProvider ?? DEFAULTS.llm.defaultProvider,
    providers: {
      claude: {
        // || guards against empty strings; ?? guards against missing keys
        model:
          SETTINGS.llm?.providers?.claude?.model ||
          DEFAULTS.llm.providers.claude.model,
        maxTokens:
          SETTINGS.llm?.providers?.claude?.maxTokens ??
          DEFAULTS.llm.providers.claude.maxTokens,
      },
      openai: {
        model:
          SETTINGS.llm?.providers?.openai?.model ||
          DEFAULTS.llm.providers.openai.model,
        maxTokens:
          SETTINGS.llm?.providers?.openai?.maxTokens ??
          DEFAULTS.llm.providers.openai.maxTokens,
      },
    },
  },
  embeddings: {
    model: SETTINGS.embeddings?.model || DEFAULTS.embeddings.model,
  },
  matching: {
    // Clamp topN to ≥ 1 — zero results would crash the LLM prompt builder
    topN: Math.max(1, SETTINGS.matching?.topN ?? DEFAULTS.matching.topN),
    // Clamp nonUSPenalty to [0, 1] — values outside this range are nonsensical
    nonUSPenalty: Math.min(
      1,
      Math.max(0, SETTINGS.matching?.nonUSPenalty ?? DEFAULTS.matching.nonUSPenalty),
    ),
    dimensionWeights: {
      // Clamp each weight to ≥ 0 — negative weights are nonsensical
      semantic:   Math.max(0, SETTINGS.matching?.dimensionWeights?.semantic   ?? DEFAULTS.matching.dimensionWeights.semantic),
      audience:   Math.max(0, SETTINGS.matching?.dimensionWeights?.audience   ?? DEFAULTS.matching.dimensionWeights.audience),
      values:     Math.max(0, SETTINGS.matching?.dimensionWeights?.values     ?? DEFAULTS.matching.dimensionWeights.values),
      tone:       Math.max(0, SETTINGS.matching?.dimensionWeights?.tone       ?? DEFAULTS.matching.dimensionWeights.tone),
      engagement: Math.max(0, SETTINGS.matching?.dimensionWeights?.engagement ?? DEFAULTS.matching.dimensionWeights.engagement),
    },
  },
  ui: {
    // Clamp to ≥ 1 so at least one niche tag always shows
    maxNichesPerCard: Math.max(
      1,
      SETTINGS.ui?.maxNichesPerCard ?? DEFAULTS.ui.maxNichesPerCard,
    ),
    maxChars: {
      // Clamp each limit to a sensible minimum so the form stays usable
      topic:         Math.max(50,  SETTINGS.ui?.maxChars?.topic         ?? DEFAULTS.ui.maxChars.topic),
      keyTakeaway:   Math.max(50,  SETTINGS.ui?.maxChars?.keyTakeaway   ?? DEFAULTS.ui.maxChars.keyTakeaway),
      context:       Math.max(100, SETTINGS.ui?.maxChars?.context       ?? DEFAULTS.ui.maxChars.context),
      targetAudience: Math.max(50, SETTINGS.ui?.maxChars?.targetAudience ?? DEFAULTS.ui.maxChars.targetAudience),
      values:        Math.max(50,  SETTINGS.ui?.maxChars?.values        ?? DEFAULTS.ui.maxChars.values),
      tone:          Math.max(50,  SETTINGS.ui?.maxChars?.tone          ?? DEFAULTS.ui.maxChars.tone),
    },
  },
};
