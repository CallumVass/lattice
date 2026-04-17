import type { LearningEntry } from "../schema/index.js";

export interface DecayConfig {
  decayRate: number;
  reinforcementBoost: number;
  invalidPenalty: number;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(later: Date, earlier: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply age-based exponential decay to each entry's confidence so long-idle
 * entries fade relative to freshly reinforced ones. Non-destructive — callers
 * use the returned list for ranking without mutating the stored copy.
 */
export function applyDecay(entries: LearningEntry[], now: Date, config: DecayConfig): LearningEntry[] {
  return entries.map((entry) => {
    const last = new Date(entry.lastSeenAt);
    const days = daysBetween(now, last);
    const decayed = entry.confidence * Math.exp(-days * config.decayRate);
    return { ...entry, confidence: clamp(decayed, 0, 1) };
  });
}

/**
 * Reinforce an entry that just matched a fresh finding. Bumps `lastSeenAt`,
 * boosts confidence (capped at 1.0), and increments `reinforcementCount` so
 * selector ranking reflects repeated occurrences.
 */
export function reinforce(entry: LearningEntry, now: Date, boost: number): LearningEntry {
  return {
    ...entry,
    confidence: clamp(entry.confidence + boost, 0, 1),
    lastSeenAt: now.toISOString(),
    reinforcementCount: entry.reinforcementCount + 1,
  };
}

export type FeedbackVerdict = "valid" | "invalid" | "stale";

/**
 * Adjust an entry based on user feedback. `valid` reinforces (same boost as
 * re-occurrence), `invalid` drops confidence and feedbackScore sharply, and
 * `stale` sets `expiresAt = now` so the selector filters it out immediately.
 */
export function applyVerdict(
  entry: LearningEntry,
  verdict: FeedbackVerdict,
  now: Date,
  config: DecayConfig,
): LearningEntry {
  const iso = now.toISOString();
  if (verdict === "valid") {
    return {
      ...entry,
      confidence: clamp(entry.confidence + config.reinforcementBoost, 0, 1),
      feedbackScore: clamp(entry.feedbackScore + 0.5, -1, 1),
      lastSeenAt: iso,
    };
  }
  if (verdict === "invalid") {
    return {
      ...entry,
      confidence: clamp(entry.confidence * (1 - config.invalidPenalty), 0, 1),
      feedbackScore: clamp(entry.feedbackScore - 0.5, -1, 1),
      lastSeenAt: iso,
    };
  }
  return {
    ...entry,
    expiresAt: iso,
    lastSeenAt: iso,
  };
}
