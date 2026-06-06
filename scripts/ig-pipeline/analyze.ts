/**
 * Analysis stage: turn the kept frames into a motion-language `Brief` by running
 * the real `claude` CLI in non-interactive print mode.
 *
 * Load-bearing mechanism (see KB gotcha `claude-cli-no-image-flag`, verified
 * against CLI 2.1.167): there is NO `--image` flag. Frames are attached by
 * listing their ABSOLUTE paths in the prompt text and enabling the multimodal
 * `Read` tool, which the agent uses to open each frame. The invocation is:
 *
 *   echo "$PROMPT" | claude -p --model <ANALYSIS_MODEL> \
 *     --allowedTools "Read" --output-format json
 *
 * `--output-format json` returns a JSON ENVELOPE; the brief is the envelope's
 * `.result` STRING, which must be JSON-parsed a SECOND time (the model may wrap
 * it in a ```json fence). Cost/latency budget from the spike (sonnet, 11 frames):
 * ~41s, ~$0.21, ~12 turns -- one Read round-trip per frame, so latency scales
 * ~linearly with frame count.
 *
 * This stage hits the network and costs money: it must never run under `bun test`.
 * The parse/validate helpers below are exported and pure so they can be unit-
 * tested against fixture envelopes without ever shelling out to `claude`.
 */

import { resolve } from "node:path";
import { CONSTANTS } from "./lib/constants.ts";
import { run, SpawnError } from "./lib/spawn.ts";
import type { AnalyzeResult, Brief } from "./types.ts";

/** The `claude` binary name (resolved on PATH by the spawn helper). */
const CLAUDE_BINARY = "claude";

/** Max characters of raw model output to include in a malformed-output error. */
const SNIPPET_LIMIT = 600;

/**
 * The motion-language extraction prompt, verbatim from the proposal's "Motion
 * Language Extraction" section, with `[N]` replaced by the real frame count and
 * an explicit instruction + list of the absolute frame paths to Read.
 *
 * The path list and the Read instruction are what attach the images: the agent
 * issues one multimodal Read per path. Paths are listed in capture order.
 */
export function buildPrompt(absoluteFramePaths: string[]): string {
  const n = absoluteFramePaths.length;
  const fileList = absoluteFramePaths
    .map((p, i) => `  ${i + 1}. ${p}`)
    .join("\n");

  return `You are a motion design creative director. You've been given frames from a
short-form video. Your job is to extract its motion language — the way it moves,
the way it feels, the way it uses time — so that a motion designer can apply
that same language to completely original content.

Do NOT describe what's literally in the video. Extract the underlying motion
vocabulary: the rhythm, the kinetic energy, the pacing, the transitions, the
feeling of being inside this video.

Here are ${n} frames from distinct moments in the video. Use your Read tool to
open EACH of these image files before answering — they are local files on disk,
listed in capture order:

${fileList}

Return ONLY the JSON object below, with every field filled in. Do not add prose
before or after it.
{
  "motionLanguage": {
    "energy": "the overall kinetic quality — e.g. 'punchy and immediate', 'fluid and drifting', 'mechanical and precise', 'nervous and reactive'",
    "rhythm": "how the piece pulses through time — e.g. 'burst-and-hold', 'steady metronomic', 'accelerating to impact', 'call-and-response'",
    "pacing": "fast cuts / held frames / slow reveals / mixed — and how that creates feeling",
    "transitions": "how scenes and elements move between states — cut, dissolve, wipe, zoom, push, or something else",
    "signature": "the one motion idea that makes this feel like itself — the thing you'd steal first"
  },
  "motionTheme": "one sentence: the emotional and kinetic identity of this piece",
  "colorMood": "the feeling the color palette creates — not the colors themselves, what they communicate",
  "typographyMotion": "how text moves if present — or 'absent'",
  "applicationGuide": "2-3 sentences: how to apply this motion language to new content — what principles to carry over, what to interpret freely, what the new piece must feel like"
}`;
}

/**
 * The relevant fields of the `claude -p --output-format json` envelope. The
 * brief lives in `result` as a JSON STRING; the rest is telemetry. Keys match
 * the CLI's snake_case envelope (e.g. `total_cost_usd`).
 */
interface ClaudeEnvelope {
  result?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  is_error?: unknown;
  subtype?: unknown;
}

/** Truncate raw output for inclusion in an error message. */
function snippet(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > SNIPPET_LIMIT
    ? `${trimmed.slice(0, SNIPPET_LIMIT)}… (${trimmed.length} chars total)`
    : trimmed;
}

/** Coerce an envelope telemetry field to a finite number, or 0 if absent/unparseable. */
function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Strip a surrounding markdown code fence (```json … ``` or ``` … ```) from a
 * model result string, if present. Leaves un-fenced input untouched.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;
  const match = trimmed.match(fence);
  return match?.[1] !== undefined ? match[1].trim() : trimmed;
}

/** The keys every `motionLanguage` sub-object must carry. */
const MOTION_LANGUAGE_KEYS = [
  "energy",
  "rhythm",
  "pacing",
  "transitions",
  "signature",
] as const;

/** The top-level string keys the brief must carry alongside `motionLanguage`. */
const BRIEF_STRING_KEYS = [
  "motionTheme",
  "colorMood",
  "typographyMotion",
  "applicationGuide",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate that `value` is a complete `Brief`: every required top-level field is
 * present as a non-empty string and the `motionLanguage` sub-object carries all
 * five keys. Returns the typed brief on success; throws a clear, actionable error
 * listing every offending field otherwise. Never returns a partially-filled brief.
 */
export function validateBrief(value: unknown): Brief {
  const problems: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Motion-language brief is not a JSON object (got ${Array.isArray(value) ? "array" : typeof value}).`,
    );
  }

  const obj = value as Record<string, unknown>;

  const ml = obj.motionLanguage;
  if (typeof ml !== "object" || ml === null || Array.isArray(ml)) {
    problems.push("motionLanguage (missing or not an object)");
  } else {
    const mlObj = ml as Record<string, unknown>;
    for (const key of MOTION_LANGUAGE_KEYS) {
      if (!isNonEmptyString(mlObj[key])) {
        problems.push(`motionLanguage.${key}`);
      }
    }
  }

  for (const key of BRIEF_STRING_KEYS) {
    if (!isNonEmptyString(obj[key])) {
      problems.push(key);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Motion-language brief is missing or has empty required field(s): ${problems.join(", ")}.`,
    );
  }

  return value as Brief;
}

/**
 * Parse the `claude -p --output-format json` stdout into a validated `Brief`
 * plus the telemetry needed for an `AnalyzeResult`. Pure and live-call-free, so
 * it is the unit-testable seam: feed it a fixture envelope string. Throws a clear
 * error (with a truncated snippet) on any malformed layer.
 */
export function parseEnvelope(stdout: string): Omit<AnalyzeResult, "model"> {
  if (stdout.trim().length === 0) {
    throw new Error("`claude` returned empty stdout; expected a JSON envelope.");
  }

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    throw new Error(
      `Could not parse the \`claude\` JSON envelope. Raw output:\n${snippet(stdout)}`,
    );
  }

  if (typeof envelope.result !== "string") {
    throw new Error(
      `\`claude\` envelope has no string \`.result\` field (is_error=${String(envelope.is_error)}, subtype=${String(envelope.subtype)}). Raw output:\n${snippet(stdout)}`,
    );
  }

  const resultJson = stripCodeFence(envelope.result);
  let parsedBrief: unknown;
  try {
    parsedBrief = JSON.parse(resultJson);
  } catch {
    throw new Error(
      `\`claude\` returned a result that is not valid JSON after fence-stripping. Result:\n${snippet(envelope.result)}`,
    );
  }

  const brief = validateBrief(parsedBrief);

  return {
    brief,
    costUsd: asNumber(envelope.total_cost_usd),
    durationMs: asNumber(envelope.duration_ms),
    numTurns: asNumber(envelope.num_turns),
  };
}

/**
 * Run the motion-language analysis over the kept frames.
 *
 * Spawns `claude -p` once, attaches the frames by listing their absolute paths
 * in the prompt with `--allowedTools "Read"` (no `--image` flag — it does not
 * exist), then double-parses the JSON envelope into a schema-valid `Brief`.
 *
 * This call hits the network and costs money (~$0.21, ~40-60s for ~11 frames):
 * never invoke it from a unit test.
 */
export async function analyze(keptFramePaths: string[]): Promise<AnalyzeResult> {
  if (keptFramePaths.length === 0) {
    throw new Error(
      "analyze() requires at least one kept frame path; nothing to analyze.",
    );
  }

  const absolutePaths = keptFramePaths.map((p) => resolve(p));
  const model = CONSTANTS.ANALYSIS_MODEL;
  const prompt = buildPrompt(absolutePaths);

  let stdout: string;
  try {
    const result = await run(
      CLAUDE_BINARY,
      ["-p", "--model", model, "--allowedTools", "Read", "--output-format", "json"],
      { stdin: prompt },
    );
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof SpawnError) {
      if (err.isBinaryNotFound) {
        throw new Error(
          `The \`claude\` CLI was not found on PATH. Install it and ensure \`claude\` is runnable (the analysis stage drives it in print mode).`,
        );
      }
      throw new Error(
        `\`claude -p\` exited with code ${err.code} during motion-language analysis.${err.stderr.trim() ? `\n${err.stderr.trim()}` : ""}`,
      );
    }
    throw err;
  }

  const parsed = parseEnvelope(stdout);
  return { ...parsed, model };
}

// ---------------------------------------------------------------------------
// Thin CLI: `bun run analyze.ts <frame paths...>` -> prints the AnalyzeResult.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const framePaths = Bun.argv.slice(2);
  if (framePaths.length === 0) {
    console.error("Usage: bun run analyze.ts <frame_path> [<frame_path> ...]");
    process.exit(2);
  }

  analyze(framePaths)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
