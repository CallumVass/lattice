import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletionContext } from "./completion.js";
import { checkCompletion } from "./completion.js";

let baseDir: string;
let signalsDir: string;

beforeEach(async () => {
  baseDir = join(tmpdir(), `lattice-completion-${Date.now()}`);
  signalsDir = join(baseDir, "signals");
  await mkdir(signalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    signalsDir,
    stageId: "test-stage",
    ...overrides,
  };
}

describe("idle", () => {
  it("always complete", async () => {
    const result = await checkCompletion("idle", ctx());
    expect(result.complete).toBe(true);
  });
});

describe("signal", () => {
  it("incomplete when no signal file", async () => {
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(false);
  });

  it("pass signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "pass", reason: "LGTM" }));
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.summary).toBe("LGTM");
  });

  it("fail signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "fail", reason: "2 issues" }));
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("fail");
  });

  it("blocked signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "blocked", reason: "Missing dep" }));
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("blocked");
  });

  it("complete signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "complete" }));
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBeUndefined();
  });

  it("treats malformed signal JSON as incomplete", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), "{");
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(false);
  });

  it("treats unknown signal status as incomplete", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "ship-it" }));
    const result = await checkCompletion("signal", ctx());
    expect(result.complete).toBe(false);
  });
});
