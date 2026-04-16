import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import { append, count, ensureGitignored, exists, readAll, type StorageOptions } from "./storage.js";

let projectDir: string;

function opts(): StorageOptions {
  return { projectDir, storePath: ".lattice/learnings.jsonl" };
}

function fixtureEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const now = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agent: "code-reviewer",
    pattern: "Null check missing",
    category: "auth",
    severity: "blocking",
    source: { pr: "#42", stageId: "propose-comments", date: now },
    confidence: 0.9,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-learnings-storage-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("storage", () => {
  it("append + readAll roundtrip preserves entries", async () => {
    const entry1 = fixtureEntry({ id: "11111111-1111-4111-8111-111111111111", pattern: "first" });
    const entry2 = fixtureEntry({ id: "22222222-2222-4222-8222-222222222222", pattern: "second" });

    await append(entry1, opts());
    await append(entry2, opts());

    const loaded = await readAll(opts());
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.pattern).toBe("first");
    expect(loaded[1]?.pattern).toBe("second");
  });

  it("readAll skips malformed lines without throwing", async () => {
    const entry = fixtureEntry();
    await append(entry, opts());
    await writeFile(
      join(projectDir, ".lattice", "learnings.jsonl"),
      `${JSON.stringify(entry)}\nnot-json\n${JSON.stringify({ ...entry, id: "broken" })}\n`,
    );

    const loaded = await readAll(opts());
    expect(loaded).toHaveLength(1);
  });

  it("count returns last-captured timestamp", async () => {
    const before = await count(opts());
    expect(before.entries).toBe(0);
    expect(before.lastCapturedAt).toBeUndefined();

    const entry = fixtureEntry({ lastSeenAt: "2026-04-16T12:00:00.000Z" });
    await append(entry, opts());

    const after = await count(opts());
    expect(after.entries).toBe(1);
    expect(after.lastCapturedAt).toBe("2026-04-16T12:00:00.000Z");
  });

  it("exists reflects the file presence", async () => {
    expect(await exists(opts())).toBe(false);
    await append(fixtureEntry(), opts());
    expect(await exists(opts())).toBe(true);
  });
});

describe("ensureGitignored", () => {
  it("appends entry to a missing .gitignore", async () => {
    await ensureGitignored(projectDir, ".lattice/learnings.jsonl");
    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".lattice/learnings.jsonl");
  });

  it("is idempotent on repeat runs", async () => {
    await writeFile(join(projectDir, ".gitignore"), "node_modules/\n");
    await ensureGitignored(projectDir, ".lattice/learnings.jsonl");
    await ensureGitignored(projectDir, ".lattice/learnings.jsonl");
    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    const occurrences = content.split("\n").filter((l) => l.trim() === ".lattice/learnings.jsonl").length;
    expect(occurrences).toBe(1);
  });

  it("does not duplicate an existing entry", async () => {
    await writeFile(join(projectDir, ".gitignore"), ".lattice/learnings.jsonl\n");
    await ensureGitignored(projectDir, ".lattice/learnings.jsonl");
    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toBe(".lattice/learnings.jsonl\n");
  });

  it("preserves the trailing newline when appending", async () => {
    await writeFile(join(projectDir, ".gitignore"), "node_modules/");
    await ensureGitignored(projectDir, ".lattice/learnings.jsonl");
    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.lattice/learnings.jsonl\n");
  });
});
