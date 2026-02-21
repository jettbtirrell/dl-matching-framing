/**
 * Shared TypeScript types for the Drumbeat Creator Matching tool.
 *
 * Why a central types file: a single source of truth for data shapes used
 * across the API route, scoring logic, Claude wrapper, and UI pages. Any time
 * a shape changes, you update it here and TypeScript surfaces every callsite
 * that needs to update too.
 */

// ---------------------------------------------------------------------------
// Creator — matches the exact shape of each record in data/creators.json
// ---------------------------------------------------------------------------

// The JSON file is an object keyed by uniqueId, NOT an array.
// Always iterate with Object.values(creatorsJson) — not creatorsJson[0] etc.
export interface Creator {
  uniqueId: string;
  nickname: string;
  bio: string;
  followerCount: number;
  followingCount: number;
  heartCount: number;
  videoCount: number;
  verified: boolean;
  region: string; // "US", "EU", "UK", "CA", etc.
  avatarUrl: string; // These are example.com placeholders that will 404 — handle gracefully in UI
  analysis: {
    summary: string;
    primaryNiches: string[];
    secondaryNiches: string[];
    identifiedCauses: string[];
    apparentValues: string[];
    socialStances: string[];
    audienceInterests: string[];
    engagementStyle: {
      tone: string[];
      contentStyle: string;
      callsToAction: string[];
    };
    partnershipPotential: {
      alignedOrganizationTypes: string[];
      contentStrengths: string[];
      considerations: string[];
    };
    topHashtags: string[];
    evidenceNotes: string;
  };
  sourceHashtags: string[];
  topHashtags: string[];
  videosAnalyzed: number;
  profileUrl: string;
  updatedAt: string;
  createdAt: string;
  crawlCount: number;
}

// ---------------------------------------------------------------------------
// Assignment — the form data submitted by the nonprofit/client
// ---------------------------------------------------------------------------

export interface Assignment {
  topic: string; // required: what is the content about?
  keyTakeaway: string; // required: the one message the audience should leave with
  context: string; // required: background, constraints, format notes
  targetAudience?: string; // optional: demographic + locale e.g. "Gen Z, US"
  values?: string; // optional: desired creator values, comma-separated
  niches?: string; // optional: content niches e.g. "lifestyle, personal finance"
  tone?: string; // optional: style guidance e.g. "conversational, relatable"
}

// ---------------------------------------------------------------------------
// Scoring + results
// ---------------------------------------------------------------------------

// A creator paired with its raw deterministic score.
// Used internally between the scoring function and the Claude call.
export interface ScoredCreator {
  creator: Creator;
  score: number; // 0.0–1.0; non-US creators are penalized (multiplied by 0.2)
}

// The final result for one creator, returned from the API and rendered in the UI.
export interface MatchResult {
  creator: Creator;
  score: number;
  matchExplanation: string; // AI-generated: 1–3 sentences on why this creator fits
  suggestedFraming: string; // AI-generated: a specific, personalized post concept
}

// The full API response shape from POST /api/match
export interface MatchApiResponse {
  results: MatchResult[];
}
