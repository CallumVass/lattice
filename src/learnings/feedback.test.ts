import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import type { DecayConfig } from "./decay.js";
import { applyFeedback } from "./feedback.js";
import { readAll, writeAll } from "./storage.js";

let projectDir: string;

const DECAY: DecayConfig = {
  decayRate: 0.05,
  reinforcementBoost: 0.15,
  invalidPenalty: 0.4,
};

const STORE_REL = ".lattice/learnings.jsonl";

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const iso = "2026-04-01T00:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agent: "*",
    pattern: "Null check missing",
    category: "auth",
    severity: "blocking",
    source: { stageId: "propose-comments", date: iso },
    confidence: 0.6,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: iso,
    lastSeenAt: iso,
    ...overrides,
  };
}

async function seed(entries: LearningEntry[]): Promise<void> {
  await writeAll(entries, { projectDir, storePath: STORE_REL });
}

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-feedback-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("applyFeedback", () => {
  it("matches on short-id and boosts the entry for a valid verdict", async () => {
    const target = entry();
    await seed([target]);

    const now = new Date("2026-05-01T00:00:00.000Z");
    const updated = await applyFeedback(
      target.id.slice(0, 8),
      "valid",
      { projectDir, storePath: STORE_REL },
      { now: () => now, decay: DECAY },
    );

    expect(updated?.confidence).toBeCloseTo(0.75, 5);
    expect(updated?.feedbackScore).toBeCloseTo(0.5, 5);

    const persisted = await readAll({ projectDir, storePath: STORE_REL });
    expect(persisted[0]?.confidence).toBeCloseTo(0.75, 5);
    expect(persisted[0]?.lastSeenAt).toBe(now.toISOString());
  });

  it("drops confidence and feedbackScore on invalid", async () => {
    const target = entry({ confidence: 0.8, feedbackScore: 0.2 });
    await seed([target]);

    const now = new Date("2026-05-01T00:00:00.000Z");
    const updated = await applyFeedback(
      target.id,
      "invalid",
      { projectDir, storePath: STORE_REL },
      {
        now: () => now,
        decay: DECAY,
      },
    );

    expect(updated?.confidence).toBeCloseTo(0.8 * 0.6, 5);
    expect(updated?.feedbackScore).toBeCloseTo(-0.3, 5);
  });

  it("expires the entry on stale", async () => {
    const target = entry();
    await seed([target]);
    const now = new Date("2026-05-01T00:00:00.000Z");
    const updated = await applyFeedback(
      target.id,
      "stale",
      { projectDir, storePath: STORE_REL },
      {
        now: () => now,
        decay: DECAY,
      },
    );
    expect(updated?.expiresAt).toBe(now.toISOString());
  });

  it("returns undefined when no entry matches", async () => {
    await seed([entry()]);
    const updated = await applyFeedback(
      "deadbeef",
      "valid",
      { projectDir, storePath: STORE_REL },
      {
        decay: DECAY,
      },
    );
    expect(updated).toBeUndefined();
  });
});
