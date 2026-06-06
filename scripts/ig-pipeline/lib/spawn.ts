/**
 * Typed wrapper over `Bun.spawn` for the external binaries the pipeline drives
 * (`yt-dlp`, `ffmpeg`, `ffprobe`, `claude`).
 *
 * The key contract: a MISSING binary must be distinguishable from a binary that
 * RAN and exited non-zero, and from a generic spawn/IO failure. A missing
 * `yt-dlp` should never look like a download that failed -- stages rely on this
 * to give actionable errors.
 */

/** Why a spawn did not produce a clean (exit 0) result. */
export type SpawnFailureKind =
  | "binary_not_found" // the executable is not on PATH (ENOENT).
  | "non_zero_exit" // the binary ran and exited with a non-zero code.
  | "spawn_error"; // some other spawn/IO failure (permissions, etc.).

/** A captured subprocess result. */
export interface SpawnResult {
  /** The exit code (0 on success). */
  code: number;
  /** Captured stdout (decoded UTF-8). */
  stdout: string;
  /** Captured stderr (decoded UTF-8). */
  stderr: string;
}

/** Error thrown by {@link run} / {@link runChecked} when a spawn does not succeed. */
export class SpawnError extends Error {
  readonly kind: SpawnFailureKind;
  readonly binary: string;
  readonly args: string[];
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    kind: SpawnFailureKind;
    binary: string;
    args: string[];
    code: number | null;
    stdout: string;
    stderr: string;
    message?: string;
  }) {
    super(params.message ?? defaultMessage(params));
    this.name = "SpawnError";
    this.kind = params.kind;
    this.binary = params.binary;
    this.args = params.args;
    this.code = params.code;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }

  /** True when the failure was a missing executable on PATH. */
  get isBinaryNotFound(): boolean {
    return this.kind === "binary_not_found";
  }
}

function defaultMessage(params: {
  kind: SpawnFailureKind;
  binary: string;
  code: number | null;
  stderr: string;
}): string {
  switch (params.kind) {
    case "binary_not_found":
      return `Required binary "${params.binary}" was not found on PATH. Install it and ensure it is on PATH (see scripts/ig-pipeline/README.md).`;
    case "non_zero_exit":
      return `"${params.binary}" exited with code ${params.code}.${params.stderr ? `\n${params.stderr.trim()}` : ""}`;
    case "spawn_error":
      return `Failed to spawn "${params.binary}": ${params.stderr || "unknown spawn error"}.`;
  }
}

/** Heuristic: does this thrown error / stderr indicate the executable was not found? */
function looksLikeMissingBinary(err: unknown): boolean {
  // Bun surfaces a missing executable as an error whose code/message mentions ENOENT.
  const anyErr = err as { code?: unknown; message?: unknown } | null;
  if (anyErr && typeof anyErr === "object") {
    if (anyErr.code === "ENOENT") return true;
    if (typeof anyErr.message === "string" && /ENOENT|not found|No such file/i.test(anyErr.message)) {
      return true;
    }
  }
  return false;
}

export interface RunOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra environment variables (merged over the inherited env). */
  env?: Record<string, string>;
  /** Data to write to the child's stdin, then close it. */
  stdin?: string;
  /**
   * If true, the child's stdout/stderr are inherited (streamed to this process's
   * tty) in addition to being captured-as-empty. Use for long-running, chatty
   * binaries (ffmpeg). Default false (capture both).
   */
  stream?: boolean;
}

/**
 * Run a binary to completion and capture its output. Throws {@link SpawnError}
 * if the binary is missing or exits non-zero. Use {@link tryRun} for a
 * non-throwing variant.
 */
export async function run(
  binary: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<SpawnResult> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([binary, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
      stdout: options.stream ? "inherit" : "pipe",
      stderr: options.stream ? "inherit" : "pipe",
    });
  } catch (err) {
    const kind: SpawnFailureKind = looksLikeMissingBinary(err) ? "binary_not_found" : "spawn_error";
    throw new SpawnError({
      kind,
      binary,
      args,
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    });
  }

  const stdout = options.stream ? "" : await new Response(proc.stdout as ReadableStream).text();
  const stderr = options.stream ? "" : await new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;

  // Bun can also surface a missing executable lazily via a 127 exit + ENOENT-ish
  // stderr rather than a thrown error, depending on platform; treat that as
  // binary-not-found so stages get the actionable error either way.
  if (code !== 0) {
    const missing = code === 127 && /not found|ENOENT|No such file/i.test(stderr);
    throw new SpawnError({
      kind: missing ? "binary_not_found" : "non_zero_exit",
      binary,
      args,
      code,
      stdout,
      stderr,
    });
  }

  return { code, stdout, stderr };
}

/**
 * Non-throwing variant of {@link run}: returns `{ ok: true, result }` on success
 * or `{ ok: false, error }` (a {@link SpawnError}) otherwise. Useful when a stage
 * wants to branch on the failure kind (e.g. yt-dlp's cookie fallback) instead of
 * catching.
 */
export async function tryRun(
  binary: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<{ ok: true; result: SpawnResult } | { ok: false; error: SpawnError }> {
  try {
    return { ok: true, result: await run(binary, args, options) };
  } catch (err) {
    if (err instanceof SpawnError) return { ok: false, error: err };
    throw err;
  }
}

/**
 * Verify a binary is present on PATH by probing it (default `--version`). Throws
 * a {@link SpawnError} of kind `binary_not_found` if it is missing. Use at the
 * start of a stage to fail fast with a clear message before doing real work.
 */
export async function assertBinary(binary: string, probeArgs: string[] = ["--version"]): Promise<void> {
  const outcome = await tryRun(binary, probeArgs);
  if (!outcome.ok && outcome.error.isBinaryNotFound) {
    throw outcome.error;
  }
  // A non-zero exit from `--version` still proves the binary exists, which is all
  // we are asserting here.
}
