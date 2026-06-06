/**
 * Download stage: turn a reel URL (or an already-local video) into a working
 * source video the rest of the pipeline operates on.
 *
 *   download(input, outDir, opts?) -> DownloadResult
 *
 * Design (from the spike + KB gotcha `instagram-public-reel-no-cookies`):
 * a public reel downloads via yt-dlp with NO auth on the first attempt. Cookies
 * are the EXCEPTION path -- we only retry with `--cookies-from-browser` when the
 * error is specifically an auth/rate-limit signature, never on a transient
 * network failure. Building no-cookie-first keeps the common case zero-config.
 *
 * This module owns only `download.ts`. Contracts, the spawn wrapper, the path
 * layout, and tuning constants all come from T-001 -- they are imported, never
 * redefined here.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import {
  type DownloadResult,
  type StageProgress,
  formatStageProgress,
} from "./types.ts";
import { tryRun, SpawnError } from "./lib/spawn.ts";
import { resolveExtractionPaths } from "./lib/paths.ts";

const YT_DLP = "yt-dlp";

/** Extensions we accept for a local (already-downloaded) source video. */
const LOCAL_VIDEO_EXTS = new Set([".mp4", ".mov", ".webm"]);

/**
 * yt-dlp format chain. `--format mp4` worked in the spike but is fragile across
 * reels (not every reel exposes a progressive mp4), so we prefer the best
 * video+audio, fall back to a single mp4-container stream, then to anything, and
 * let `--merge-output-format mp4` remux the result into the `source.mp4` target.
 */
const FORMAT_CHAIN = "bv*+ba/b[ext=mp4]/b";

/**
 * Conservative auth-signature substrings (lower-cased) that justify the ONE
 * cookie retry. These are yt-dlp's login / age-gate / rate-limit phrasings for
 * Instagram. We deliberately do NOT match transient failures here -- "Unable to
 * download webpage", HTTP 5xx, and timeouts must fall through and re-throw, not
 * trigger a cookie fallback (a cookie retry would not fix a flaky network and
 * would mask the real error).
 */
const AUTH_SIGNATURES = [
  "login required",
  "login_required",
  "rate-limit reached",
  "rate limit reached",
  "sign in to confirm your age",
  "restricted video",
  "requested content is not available",
  "use --cookies", // yt-dlp's own remediation hint ("Use --cookies-from-browser or --cookies ...")
  "this account is private",
] as const;

/** Does this yt-dlp stderr carry an auth/rate-limit signature (vs. a transient error)? */
function isAuthError(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return AUTH_SIGNATURES.some((sig) => haystack.includes(sig));
}

export interface DownloadOptions {
  /** Browser to pull cookies from on the auth fallback. Default: env `IG_COOKIE_BROWSER` or `firefox`. */
  cookieBrowser?: string;
  /** Override the yt-dlp binary name/path (mainly for tests). Default `yt-dlp`. */
  ytDlpBinary?: string;
  /** Date used for the extraction folder name; defaults to now. Pass a fixed Date in tests. */
  date?: Date;
  /** Progress sink. The CLI wires this to stdout; `run.ts` can compose it differently. */
  onProgress?: (p: StageProgress) => void;
}

function resolveCookieBrowser(opts: DownloadOptions): string {
  return opts.cookieBrowser ?? process.env.IG_COOKIE_BROWSER ?? "firefox";
}

function emit(opts: DownloadOptions, progress: number, message?: string): void {
  opts.onProgress?.({ stage: "download", progress, message });
}

/**
 * Run yt-dlp no-cookie-first, retrying ONCE with `--cookies-from-browser` only
 * when the failure is an auth/rate-limit signature. Returns the successful
 * stdout plus whether cookies were needed.
 *
 * `forceCookies` short-circuits the no-cookie attempt: once an earlier yt-dlp
 * call (e.g. the metadata probe) has already proven cookies are required, later
 * calls go straight to the cookie path instead of re-failing the no-auth attempt.
 */
async function ytDlp(
  binary: string,
  args: string[],
  cookieBrowser: string,
  forceCookies: boolean,
): Promise<{ stdout: string; usedCookies: boolean }> {
  if (!forceCookies) {
    const first = await tryRun(binary, args);
    if (first.ok) return { stdout: first.result.stdout, usedCookies: false };

    // A missing binary is not an auth problem -- surface the actionable
    // "not found on PATH" error from the spawn wrapper unchanged.
    if (first.error.isBinaryNotFound) throw first.error;

    // Only an auth signature justifies the cookie retry; anything else
    // (transient network, real download failure) re-throws as-is.
    if (!isAuthError(first.error.stderr)) throw first.error;
  }

  const withCookies = [...args, "--cookies-from-browser", cookieBrowser];
  const second = await tryRun(binary, withCookies);
  if (second.ok) return { stdout: second.result.stdout, usedCookies: true };
  throw second.error;
}

/** Stable 11-char id for a local file, derived from its absolute path (not its bytes -- cheap and deterministic). */
function localFileId(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 11);
}

/** Parse yt-dlp's `%(duration)s` print output; yt-dlp emits "NA" when unknown. */
function parseDuration(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * After a download, confirm the expected `source.mp4` exists; if yt-dlp's
 * remux landed a different extension, find the `source.*` it actually wrote and
 * return that. `DownloadResult.sourcePath` must point at the file that exists on
 * disk, not an assumed name.
 */
async function resolveLandedFile(dir: string, expectedMp4: string): Promise<string> {
  if (await fileExists(expectedMp4)) return expectedMp4;
  const entries = await readdir(dir);
  const landed = entries.find((e) => e.startsWith("source.") && e !== "source.");
  if (!landed) {
    throw new Error(
      `yt-dlp reported success but no source.* file was found in ${dir}. ` +
        `Expected ${expectedMp4}.`,
    );
  }
  return join(dir, landed);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Ingest `input` into a working source video.
 *
 * - Local file (`.mp4`/`.mov`/`.webm` that exists): used in place, no copy, no
 *   yt-dlp. `durationSeconds` is left 0 (unknown) -- clip.ts/ffprobe is the
 *   authority on duration.
 * - URL: probed for id + duration, then downloaded into the per-source folder
 *   from `lib/paths.ts` as `source.mp4`.
 *
 * `outDir` is the output root that contains (or will contain) `extractions/`.
 */
export async function download(
  input: string,
  outDir: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  emit(opts, 0);

  if (!isUrl(input)) {
    const result = await downloadLocal(input);
    emit(opts, 1);
    return result;
  }

  const result = await downloadUrl(input, outDir, opts);
  emit(opts, 1);
  return result;
}

/** Local-file branch: validate and use in place. Never invokes yt-dlp. */
async function downloadLocal(input: string): Promise<DownloadResult> {
  const absPath = resolve(input);
  const ext = extname(absPath).toLowerCase();

  if (!LOCAL_VIDEO_EXTS.has(ext)) {
    throw new Error(
      `Unsupported local video extension "${ext || "(none)"}" for ${absPath}. ` +
        `Supported: ${[...LOCAL_VIDEO_EXTS].join(", ")}. ` +
        `(A reel URL must start with http:// or https://.)`,
    );
  }
  if (!(await fileExists(absPath))) {
    throw new Error(
      `Local input file does not exist: ${absPath}. ` +
        `Pass an existing ${[...LOCAL_VIDEO_EXTS].join("/")} file, or a reel URL.`,
    );
  }

  return {
    sourcePath: absPath,
    id: localFileId(absPath),
    sourceUrl: null,
    // Unknown until ffprobe runs in the clip stage; 0 is the "not yet probed" sentinel.
    durationSeconds: 0,
    usedCookieFallback: false,
  };
}

/** URL branch: metadata probe (for the id) -> download into the computed folder. */
async function downloadUrl(
  url: string,
  outDir: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const binary = opts.ytDlpBinary ?? YT_DLP;
  const cookieBrowser = resolveCookieBrowser(opts);

  // 1) Metadata-only probe: resolve the id (needed to build the output folder
  //    name) and duration without downloading. Avoids the double-download trap.
  emit(opts, 0.05, "probing metadata");
  const probe = await ytDlp(
    binary,
    ["--skip-download", "--no-playlist", "--print", "%(id)s", "--print", "%(duration)s", url],
    cookieBrowser,
    false,
  );
  const [idLine = "", durationLine = ""] = probe.stdout.trim().split("\n");
  const id = idLine.trim();
  if (!id) {
    throw new Error(`yt-dlp did not report an id for ${url}; cannot name the output folder.`);
  }
  const durationSeconds = parseDuration(durationLine);

  // 2) Compute the per-source folder and ensure it exists before writing into it.
  const paths = resolveExtractionPaths(outDir, id, { date: opts.date });
  await mkdir(paths.dir, { recursive: true });

  // 3) Download into <dir>/source.mp4. If the probe already needed cookies, go
  //    straight to the cookie path for the heavier download too.
  emit(opts, 0.1, "downloading");
  const dl = await ytDlp(
    binary,
    [
      "--no-playlist",
      "--no-progress",
      "-f",
      FORMAT_CHAIN,
      "--merge-output-format",
      "mp4",
      "-o",
      paths.sourceMp4,
      url,
    ],
    cookieBrowser,
    probe.usedCookies,
  );

  const sourcePath = await resolveLandedFile(paths.dir, paths.sourceMp4);

  return {
    sourcePath,
    id,
    sourceUrl: url,
    durationSeconds,
    usedCookieFallback: probe.usedCookies || dl.usedCookies,
  };
}

// ---------------------------------------------------------------------------
// CLI: `bun run download.ts <url-or-path> [outDir]`
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [input, outDir = "."] = process.argv.slice(2);
  if (!input) {
    console.error("usage: bun run download.ts <url-or-path> [outDir]");
    process.exit(2);
  }

  download(input, outDir, {
    // Per the types.ts contract, StageProgress is emitted to stdout as
    // `STAGE <name> <0..1>` lines. The DownloadResult JSON is the final,
    // single, non-`STAGE ` line, so run.ts composes progress + result from one
    // stdout stream.
    onProgress: (p) => console.log(formatStageProgress(p)),
  })
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((err) => {
      if (err instanceof SpawnError) {
        console.error(err.message);
      } else {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    });
}
