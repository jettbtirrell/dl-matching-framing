/**
 * Framing generation — match explanations and post framings for each creator.
 *
 * PRIMARY: Claude (claude-haiku-4-5-20251001)
 * FALLBACK: OpenAI (gpt-4o-mini) — used automatically if Claude fails for any reason.
 *
 * A/B TESTING:
 * Pass options.preferredProvider = "openai" to route a session directly to
 * OpenAI, bypassing Claude entirely. Used by the llm_provider experiment in
 * lib/experiments.ts to compare framing quality between models.
 *
 * WHY A SINGLE BATCHED PROMPT FOR ALL 3 CREATORS?
 * One call is cheaper, faster, and more coherent than 3 parallel calls:
 * - Cheaper: assignment context is sent once, not three times
 * - Faster: one network round-trip instead of three
 * - More coherent: the model can ensure the 3 framings are distinct when it
 *   sees all creators at once (vs. potentially repeating the same angle)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Assignment, MatchResult, ScoredCreator } from "@/types";
import { config } from "@/lib/config";
import type { LLMProviderName } from "@/lib/config";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CreatorFraming {
  uniqueId: string;
  matchExplanation: string;
  suggestedFraming: string;
}

interface FramingResponse {
  creators: CreatorFraming[];
}

interface LLMCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Serialize one field into a "Label: value" line.
 * Returns an empty string (filtered out below) if the value is blank or an empty array.
 */
function field(label: string, value: string | string[] | undefined | null): string {
  if (Array.isArray(value)) {
    const joined = value.filter(Boolean).join(", ");
    return joined ? `${label}: ${joined}` : "";
  }
  const str = (value ?? "").trim();
  return str ? `${label}: ${str}` : "";
}

function buildCreatorSummary(sc: ScoredCreator, index: number): string {
  const c = sc.creator;
  const a = c.analysis;
  return [
    `--- Creator ${index + 1}: ${c.nickname} (@${c.uniqueId}) ---`,
    field("Bio", c.bio),
    field("Summary", a.summary),
    field("Primary niches", a.primaryNiches),
    field("Secondary niches", a.secondaryNiches),
    field("Values", a.apparentValues),
    field("Social stances", a.socialStances),
    field("Identified causes", a.identifiedCauses),
    field("Audience interests", a.audienceInterests),
    field("Tone", a.engagementStyle.tone),
    field("Content style", a.engagementStyle.contentStyle),
    field("Calls to action", a.engagementStyle.callsToAction),
    field("Aligned org types", a.partnershipPotential.alignedOrganizationTypes),
    field("Content strengths", a.partnershipPotential.contentStrengths),
    field("Considerations", a.partnershipPotential.considerations),
    field("Top hashtags", a.topHashtags),
    field("Source hashtags", c.sourceHashtags),
    field("Evidence notes", a.evidenceNotes),
    `Match score: ${(sc.score * 100).toFixed(0)}/100`,
  ].filter(Boolean).join("\n");
}

/**
 * Build the shared prompt used by both Claude and the OpenAI fallback.
 * Single source of truth — both models get identical instructions.
 */
function buildPrompt(
  scoredCreators: ScoredCreator[],
  assignment: Assignment,
): string {
  const creatorSummaries = scoredCreators
    .map((sc, i) => buildCreatorSummary(sc, i))
    .join("\n\n");

  return `You are a creative strategist helping a nonprofit match with TikTok creators for paid content campaigns.

ASSIGNMENT BRIEF:
Topic: ${assignment.topic}
Key takeaway: ${assignment.keyTakeaway}
Context: ${assignment.context}
Target audience: ${assignment.targetAudience || "Not specified"}
Desired creator values: ${assignment.values || "Not specified"}
Desired tone: ${assignment.tone || "Not specified"}

TOP 3 MATCHED CREATORS (ranked by algorithmic score):
${creatorSummaries}

YOUR TASK:
For each creator, write two things:

1. matchExplanation (1–3 sentences): Why this specific creator is a strong fit for this specific assignment. Reference their actual niche, tone, audience, or values — do NOT write generic praise like "they have great engagement." Be concrete.

2. suggestedFraming (2–4 sentences): A concrete, personalized content concept this creator could execute. Tailor it to their established style and their audience's interests. Respect the assignment constraints from the context field. Make each creator's framing distinct — do not repeat the same angle across all three.

Respond with valid JSON only. No markdown, no code fences, no explanation outside the JSON:
{
  "creators": [
    {
      "uniqueId": "exact_unique_id",
      "matchExplanation": "...",
      "suggestedFraming": "..."
    }
  ]
}

IMPORTANT: Return exactly 3 creators. The uniqueId must exactly match the creator's uniqueId shown above (e.g. "mindsovermoney", not "@mindsovermoney"). Return creators in the same order they appear above.`;
}

/** Strip markdown code fences if a model wraps its JSON response despite instructions. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return trimmed;
}

/** Parse and validate a JSON framing response. Throws with a provider-tagged message on failure. */
function parseFramingResponse(raw: string, provider: string): FramingResponse {
  const json = stripCodeFences(raw);
  let parsed: FramingResponse;
  try {
    parsed = JSON.parse(json) as FramingResponse;
  } catch {
    throw new Error(
      `${provider} returned invalid JSON. First 300 chars: ${json.slice(0, 300)}`,
    );
  }
  if (!parsed.creators || !Array.isArray(parsed.creators)) {
    throw new Error(`${provider} response missing 'creators' array`);
  }
  return parsed;
}

/**
 * Merge parsed creator framings back with the original scored creators.
 * Primary lookup by uniqueId; positional fallback handles minor casing/prefix differences.
 */
function mergeFramings(
  scoredCreators: ScoredCreator[],
  parsed: FramingResponse,
): MatchResult[] {
  return scoredCreators.map((sc, index) => {
    const framingById = parsed.creators.find(
      (c) => c.uniqueId === sc.creator.uniqueId,
    );
    const framing = framingById ?? parsed.creators[index];
    return {
      creator: sc.creator,
      score: sc.score,
      matchExplanation:
        framing?.matchExplanation ?? "Match explanation not available.",
      suggestedFraming:
        framing?.suggestedFraming ?? "Suggested framing not available.",
    };
  });
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callClaude(prompt: string): Promise<LLMCallResult> {
  const { model, maxTokens } = config.llm.providers.claude;
  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  if (process.env.NODE_ENV === "development") {
    console.log("[claude] Raw response:", textBlock.text.slice(0, 300));
  }
  return {
    text: textBlock.text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

async function callOpenAI(prompt: string): Promise<LLMCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.providers.openai.model,
      max_tokens: config.llm.providers.openai.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI chat API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  const text = json.choices[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no content");

  if (process.env.NODE_ENV === "development") {
    console.log("[openai] Raw response:", text.slice(0, 300));
  }
  return {
    text,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: json.usage.completion_tokens,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface FramingResult {
  results: MatchResult[];
  /** Which model actually generated the framings — used for analytics logging. */
  provider: "claude" | "openai" | "openai-fallback";
  /** Set when provider is "openai-fallback" — the error that caused Claude to fail. */
  fallbackReason?: string;
  /** Total LLM wall-clock latency in ms (includes fallback time if applicable). */
  latencyMs: number;
  /** Input token count from the LLM API response. */
  inputTokens: number;
  /** Output token count from the LLM API response. */
  outputTokens: number;
}

/**
 * Generate match explanations and post framings for the top 3 creators.
 *
 * options.preferredProvider:
 *   "claude"  (default) — try Claude first, fall back to OpenAI on any failure
 *   "openai"            — skip Claude and call OpenAI directly (A/B experiment)
 *
 * Returns { results, provider } so the caller can log which model actually ran.
 */
export async function generateFramings(
  scoredCreators: ScoredCreator[],
  assignment: Assignment,
  options?: { preferredProvider?: LLMProviderName },
): Promise<FramingResult> {
  const prompt = buildPrompt(scoredCreators, assignment);
  const preferred = options?.preferredProvider ?? config.llm.defaultProvider;
  const llmStart = Date.now();

  // --- Direct OpenAI path (A/B experiment variant) ---
  if (preferred === "openai") {
    const { text: raw, inputTokens, outputTokens } = await callOpenAI(prompt);
    const parsed = parseFramingResponse(raw, "OpenAI");
    if (process.env.NODE_ENV === "development") {
      console.log(
        "[openai] Returned uniqueIds:",
        parsed.creators.map((c) => c.uniqueId),
      );
    }
    return {
      results: mergeFramings(scoredCreators, parsed),
      provider: "openai",
      latencyMs: Date.now() - llmStart,
      inputTokens,
      outputTokens,
    };
  }

  // --- Claude with OpenAI fallback (default path) ---
  try {
    const { text: raw, inputTokens, outputTokens } = await callClaude(prompt);
    const parsed = parseFramingResponse(raw, "Claude");
    if (process.env.NODE_ENV === "development") {
      console.log(
        "[claude] Returned uniqueIds:",
        parsed.creators.map((c) => c.uniqueId),
      );
    }
    return {
      results: mergeFramings(scoredCreators, parsed),
      provider: "claude",
      latencyMs: Date.now() - llmStart,
      inputTokens,
      outputTokens,
    };
  } catch (claudeError) {
    const fallbackReason =
      claudeError instanceof Error ? claudeError.message : String(claudeError);
    console.error("[claude] Claude failed, falling back to OpenAI:", fallbackReason);

    const { text: raw, inputTokens, outputTokens } = await callOpenAI(prompt);
    const parsed = parseFramingResponse(raw, "OpenAI (fallback)");
    return {
      results: mergeFramings(scoredCreators, parsed),
      provider: "openai-fallback",
      fallbackReason,
      latencyMs: Date.now() - llmStart,
      inputTokens,
      outputTokens,
    };
  }
}
