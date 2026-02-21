/**
 * check-readme.mjs — README completeness gate
 *
 * Verifies that README.md contains every section required by the evaluation
 * criteria. Run manually or add to CI:
 *
 *   npm run check-readme
 *
 * Exit 0 = all checks pass. Exit 1 = one or more sections missing.
 *
 * HOW TO ADD A REQUIREMENT:
 *   Add an entry to REQUIREMENTS below. `label` is shown in error output;
 *   `pattern` is a regex tested against the full README text.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const readmePath = resolve(process.cwd(), "README.md");
let readme;
try {
  readme = readFileSync(readmePath, "utf8");
} catch {
  console.error("❌ README.md not found at", readmePath);
  process.exit(1);
}

const REQUIREMENTS = [
  // ── Required sections (headings) ─────────────────────────────────────────
  {
    label: 'Section: "How to run" (Quick Start)',
    pattern: /^##\s+Quick Start/im,
  },
  {
    label: 'Section: "What AI is used for (and why)"',
    pattern: /^##\s+What AI Is Used For/im,
  },
  {
    label: 'Section: "Matching approach"',
    pattern: /^##\s+Matching Approach/im,
  },
  {
    label: 'Section: "UX decisions"',
    pattern: /^##\s+UX Decisions/im,
  },
  {
    label: 'Section: "Model and provider choices"',
    pattern: /^##\s+Model and Provider Choices/im,
  },
  {
    label: 'Section: "Framing prompt"',
    pattern: /^##\s+Framing Prompt/im,
  },
  {
    label: 'Section: "Guardrails"',
    pattern: /^##\s+Guardrails/im,
  },
  {
    label: 'Section: "What\'s next (1-2 weeks)"',
    pattern: /^##\s+What.s Next/im,
  },

  // ── Content requirements (evaluation criteria) ───────────────────────────
  {
    label: "Cost handling — must mention actual cost figures or cost strategy",
    pattern: /\bcost\b.*(\$|MTok|per request|embedding call)/i,
  },
  {
    label: "Latency handling — must mention latency figures or latency strategy",
    pattern: /latency|~\d+ms|\d+ms/i,
  },
  {
    label: "Reliability handling — must mention fallback or redundancy",
    pattern: /fallback|redundan/i,
  },
  {
    label:
      "Imperfect match handling — must address what happens when no strong match exists",
    pattern:
      /no strong match|no perfect match|imperfect|best available|below a threshold|when.*match.*doesn.t exist/i,
  },
  {
    label:
      "UI loading state — must mention shimmer, skeleton, or loading behavior",
    pattern: /shimmer|skeleton|loading state|scored.*event/i,
  },
  {
    label:
      "UI error state — must mention error state or error event handling",
    pattern: /error.*state|error.*event|error.*message|SSE.*error/i,
  },
  {
    label:
      "UI empty/insufficient state — must mention empty or insufficient brief handling",
    pattern: /insufficient|too vague|empty.*state|sparse.*brief/i,
  },
  {
    label:
      "Where AI is NOT used — must explicitly state what AI doesn't do",
    pattern: /where AI is (explicitly )?not used|AI.*not.*used/i,
  },
  {
    label:
      "Prompt engineering judgment — prompt must be shown or referenced with rationale",
    pattern: /buildPrompt|framing prompt/i,
  },
  {
    label: "Production hardening path — must mention what's missing for prod",
    pattern: /production|not yet in place|hardening|sanitiz|moderat/i,
  },
];

let passed = 0;
let failed = 0;

for (const { label, pattern } of REQUIREMENTS) {
  if (pattern.test(readme)) {
    passed++;
  } else {
    console.error(`❌  MISSING: ${label}`);
    failed++;
  }
}

console.log(`\n${passed} / ${passed + failed} checks passed.`);

if (failed > 0) {
  console.error(
    `\n${failed} requirement(s) not met. Update README.md and re-run:\n  npm run check-readme\n`,
  );
  process.exit(1);
} else {
  console.log("✅  README meets all requirements.\n");
}
