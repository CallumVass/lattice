import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletionContext } from "./completion.js";
import { checkCompletion } from "./completion.js";

let baseDir: string;
let plansDir: string;
let signalsDir: string;

beforeEach(async () => {
  baseDir = join(tmpdir(), `lattice-completion-${Date.now()}`);
  plansDir = join(baseDir, "plans");
  signalsDir = join(baseDir, "signals");
  await mkdir(plansDir, { recursive: true });
  await mkdir(signalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    plansDir,
    signalsDir,
    slug: "test-feature",
    stageId: "test-stage",
    ...overrides,
  };
}

describe("plan_created", () => {
  it("incomplete when file missing", async () => {
    const result = await checkCompletion("plan_created", ctx());
    expect(result.complete).toBe(false);
  });

  it("complete when file exists", async () => {
    await writeFile(join(plansDir, "test-feature.md"), "# Plan");
    const result = await checkCompletion("plan_created", ctx());
    expect(result.complete).toBe(true);
  });
});

describe("plan_complete", () => {
  it("incomplete when file missing", async () => {
    const result = await checkCompletion("plan_complete", ctx());
    expect(result.complete).toBe(false);
  });

  it("incomplete when unchecked items remain", async () => {
    await writeFile(join(plansDir, "test-feature.md"), "- [x] done\n- [ ] not done\n");
    const result = await checkCompletion("plan_complete", ctx());
    expect(result.complete).toBe(false);
  });

  it("complete when all items checked", async () => {
    await writeFile(join(plansDir, "test-feature.md"), "- [x] first\n- [x] second\n");
    const result = await checkCompletion("plan_complete", ctx());
    expect(result.complete).toBe(true);
    expect(result.summary).toContain("2 items");
  });

  it("incomplete when no checkboxes at all", async () => {
    await writeFile(join(plansDir, "test-feature.md"), "# Plan\nSome text\n");
    const result = await checkCompletion("plan_complete", ctx());
    expect(result.complete).toBe(false);
  });
});

describe("idle", () => {
  it("always complete", async () => {
    const result = await checkCompletion("idle", ctx());
    expect(result.complete).toBe(true);
  });
});

describe("tool_signal", () => {
  it("incomplete when no signal file", async () => {
    const result = await checkCompletion("tool_signal", ctx());
    expect(result.complete).toBe(false);
  });

  it("approve signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "approve", reason: "LGTM" }));
    const result = await checkCompletion("tool_signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(result.summary).toBe("LGTM");
  });

  it("reject signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "reject", reason: "2 issues" }));
    const result = await checkCompletion("tool_signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("reject");
  });

  it("blocked signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "blocked", reason: "Missing dep" }));
    const result = await checkCompletion("tool_signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe("blocked");
  });

  it("complete signal", async () => {
    await writeFile(join(signalsDir, "test-stage.json"), JSON.stringify({ status: "complete" }));
    const result = await checkCompletion("tool_signal", ctx());
    expect(result.complete).toBe(true);
    expect(result.verdict).toBeUndefined();
  });
});
