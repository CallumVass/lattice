import { describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import { applyDecay, applyVerdict, type DecayConfig, reinforce } from "./decay.js";

const CONFIG: DecayConfig = {
  decayRate: 0.05,
  reinforcementBoost: 0.15,
  invalidPenalty: 0.4,
};

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const iso = "2026-04-01T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-000000000000",
    agent: "code-reviewer",
    pattern: "Null check missing",
    category: "auth",
    severity: "blocking",
    source: { stageId: "propose-comments", date: iso },
    confidence: 0.8,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: iso,
    lastSeenAt: iso,
    ...overrides,
  };
}

describe("applyDecay", () => {
  it("reduces confidence as age grows per the exponential formula", () => {
    const e = entry({ confidence: 0.9, lastSeenAt: "2026-04-01T00:00:00.000Z" });
    const now = new Date("2026-04-11T00:00:00.000Z"); // 10 days later
    const [decayed] = applyDecay([e], now, CONFIG);
    expect(decayed?.confidence).toBeCloseTo(0.9 * Math.exp(-10 * 0.05), 5);
  });

  it("leaves a same-day entry untouched", () => {
    const e = entry({ confidence: 0.8, lastSeenAt: "2026-04-01T12:00:00.000Z" });
    const now = new Date("2026-04-01T12:00:00.000Z");
    const [decayed] = applyDecay([e], now, CONFIG);
    expect(decayed?.confidence).toBeCloseTo(0.8, 5);
  });

  it("does not mutate the input entries", () => {
    const e = entry({ confidence: 0.8 });
    applyDecay([e], new Date("2026-05-01T00:00:00.000Z"), CONFIG);
    expect(e.confidence).toBe(0.8);
  });
});

describe("reinforce", () => {
  it("bumps confidence, lastSeenAt, and reinforcementCount", () => {
    const e = entry({ confidence: 0.6, reinforcementCount: 1 });
    const now = new Date("2026-04-10T00:00:00.000Z");
    const r = reinforce(e, now, 0.15);
    expect(r.confidence).toBeCloseTo(0.75, 5);
    expect(r.lastSeenAt).toBe(now.toISOString());
    expect(r.reinforcementCount).toBe(2);
  });

  it("caps confidence at 1.0", () => {
    const e = entry({ confidence: 0.95 });
    const r = reinforce(e, new Date(), 0.2);
    expect(r.confidence).toBe(1);
  });
});

describe("applyVerdict", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");

  it("valid → boost confidence and feedbackScore", () => {
    const e = entry({ confidence: 0.5, feedbackScore: 0 });
    const r = applyVerdict(e, "valid", now, CONFIG);
    expect(r.confidence).toBeCloseTo(0.65, 5);
    expect(r.feedbackScore).toBeCloseTo(0.5, 5);
    expect(r.lastSeenAt).toBe(now.toISOString());
  });

  it("invalid → drop confidence by the penalty factor and feedbackScore", () => {
    const e = entry({ confidence: 0.8, feedbackScore: 0 });
    const r = applyVerdict(e, "invalid", now, CONFIG);
    expect(r.confidence).toBeCloseTo(0.8 * 0.6, 5);
    expect(r.feedbackScore).toBeCloseTo(-0.5, 5);
  });

  it("stale → set expiresAt to now without touching confidence", () => {
    const e = entry({ confidence: 0.7 });
    const r = applyVerdict(e, "stale", now, CONFIG);
    expect(r.expiresAt).toBe(now.toISOString());
    expect(r.confidence).toBe(0.7);
  });

  it("clamps feedbackScore into [-1, 1]", () => {
    const bottom = applyVerdict(entry({ feedbackScore: -0.9 }), "invalid", now, CONFIG);
    const top = applyVerdict(entry({ feedbackScore: 0.9 }), "valid", now, CONFIG);
    expect(bottom.feedbackScore).toBeCloseTo(-1, 5);
    expect(top.feedbackScore).toBeCloseTo(1, 5);
  });
});
