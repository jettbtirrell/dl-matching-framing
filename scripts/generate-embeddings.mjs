/**
 * Pre-computes creator embeddings and saves them to data/creator-embeddings.json.
 *
 * Run once (and again whenever creators.json or the embedding model changes):
 *   npm run generate-embeddings
 *
 * The output file is committed to the repo. Once it exists, the app never
 * calls OpenAI for creator embeddings — only the per-request assignment
 * embedding (~100ms) hits the API at runtime.
 *
 * FILE FORMAT: each creator gets its own entry with an embeddedAt timestamp.
 * At runtime, the app compares each creator's updatedAt against embeddedAt —
 * any creator updated after their embedding was generated gets automatically
 * re-embedded on the next cold start (in development) or on next deploy
 * (in production, re-run this script and redeploy).
 *
 * IMPORTANT: If you change DEFAULTS.embeddings.model in lib/config.ts,
 * re-run this script so the cached vectors match the new model.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Load .env.local so OPENAI_API_KEY is available without shell gymnastics
// ---------------------------------------------------------------------------

try {
  const env = readFileSync(join(root, ".env.local"), "utf-8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env.local not found — rely on shell environment
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set.");
  console.error("Add it to .env.local or set it in your shell before running.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config — keep EMBEDDING_MODEL in sync with DEFAULTS.embeddings.model
// in lib/config.ts. Re-run this script whenever you change it.
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-3-small";

// ---------------------------------------------------------------------------
// Creator text serialization — mirrors creatorToText() in lib/embeddings.ts.
// Both must produce identical strings so the cached vectors are valid.
// ---------------------------------------------------------------------------

function creatorToText(creator) {
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

// ---------------------------------------------------------------------------
// Vector normalization — mirrors normalize() in lib/embeddings.ts
// ---------------------------------------------------------------------------

function normalize(v) {
  const mag = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const creatorsPath = join(root, "data", "creators.json");
const outputPath = join(root, "data", "creator-embeddings.json");

const creatorsData = JSON.parse(readFileSync(creatorsPath, "utf-8"));
const creators = Object.values(creatorsData);

console.log(`Embedding ${creators.length} creators with ${EMBEDDING_MODEL}…`);

const texts = creators.map(creatorToText);

const res = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`OpenAI API error ${res.status}:`, body);
  process.exit(1);
}

const json = await res.json();
const ordered = json.data.sort((a, b) => a.index - b.index);
const embeddedAt = new Date().toISOString();

// Build per-creator entries: { embeddedAt, vector }
const entries = {};
for (let i = 0; i < creators.length; i++) {
  entries[creators[i].uniqueId] = {
    embeddedAt,
    vector: normalize(ordered[i].embedding),
  };
}

const output = {
  model: EMBEDDING_MODEL,
  entries,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`Done. Wrote ${creators.length} embeddings to data/creator-embeddings.json`);
console.log(`Model: ${EMBEDDING_MODEL} · embeddedAt: ${embeddedAt}`);
