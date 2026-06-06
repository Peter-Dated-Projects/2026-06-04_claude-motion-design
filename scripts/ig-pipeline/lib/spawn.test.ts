import { describe, expect, test } from "bun:test";
import { assertBinary, run, SpawnError, tryRun } from "./spawn.ts";

// A binary name that is essentially guaranteed not to exist on PATH.
const MISSING = "ig-pipeline-definitely-not-a-real-binary-xyz";

describe("run", () => {
  test("captures stdout/stderr and exit code on success", async () => {
    const res = await run("printf", ["hello"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hello");
  });

  test("writes stdin through to the child", async () => {
    const res = await run("cat", [], { stdin: "piped-input" });
    expect(res.stdout).toBe("piped-input");
  });

  test("throws a typed binary_not_found error for a missing binary", async () => {
    let caught: unknown;
    try {
      await run(MISSING);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SpawnError);
    const err = caught as SpawnError;
    expect(err.kind).toBe("binary_not_found");
    expect(err.isBinaryNotFound).toBe(true);
    expect(err.binary).toBe(MISSING);
  });

  test("distinguishes a non-zero exit from a missing binary", async () => {
    // `false` exists and exits 1 -> non_zero_exit, NOT binary_not_found.
    let caught: SpawnError | undefined;
    try {
      await run("false");
    } catch (err) {
      caught = err as SpawnError;
    }
    expect(caught).toBeInstanceOf(SpawnError);
    expect(caught?.kind).toBe("non_zero_exit");
    expect(caught?.isBinaryNotFound).toBe(false);
    expect(caught?.code).toBe(1);
  });
});

describe("tryRun", () => {
  test("returns ok:true with the result on success", async () => {
    const outcome = await tryRun("printf", ["ok"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.stdout).toBe("ok");
  });

  test("returns ok:false with a typed error for a missing binary", async () => {
    const outcome = await tryRun(MISSING);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("binary_not_found");
    }
  });
});

describe("assertBinary", () => {
  test("rejects when the binary is missing", async () => {
    await expect(assertBinary(MISSING)).rejects.toBeInstanceOf(SpawnError);
  });

  test("resolves for a binary that exists (even if --version is unconventional)", async () => {
    // `sh -c 'exit 0'`-style: `sh` exists, so assertBinary must not throw.
    await expect(assertBinary("sh", ["-c", "exit 0"])).resolves.toBeUndefined();
  });
});
