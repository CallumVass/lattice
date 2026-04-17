import type { LearningEntry } from "../schema/index.js";
import type { ResolvedLearningsConfig } from "./capture.js";
import type { RunMetrics } from "./metrics.js";

const MS_PER_DAY = 86_400_000;

export interface WeeklyBucket {
  /** ISO date (YYYY-MM-DD) of the Monday that starts the week. */
  weekStart: string;
  count: number;
}

export type FindingsTrend = Record<string, WeeklyBucket[]>;

function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket run-level findings counts into weekly totals per category. Only runs
 * within `windowDays` of `now` are considered. Categories with no findings in
 * the window are omitted entirely so the report stays focused on active
 * patterns.
 */
export function findingsTrendByCategory(
  metrics: RunMetrics[],
  windowDays: number,
  now: Date = new Date(),
): FindingsTrend {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const trend: FindingsTrend = {};

  for (const run of metrics) {
    const ts = Date.parse(run.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const start = weekStart(new Date(ts));
    for (const [category, count] of Object.entries(run.byCategory)) {
      const buckets = trend[category] ?? [];
      const existing = buckets.find((b) => b.weekStart === start);
      if (existing) {
        existing.count += count;
      } else {
        buckets.push({ weekStart: start, count });
      }
      trend[category] = buckets;
    }
  }

  for (const buckets of Object.values(trend)) {
    buckets.sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  }
  return trend;
}

/**
 * Top-N entries by reinforcement count (ties broken by confidence). Negative
 * entries are excluded — the insights surface focuses on positive patterns the
 * repo should keep observing.
 */
export function topReinforced(entries: LearningEntry[], n: number): LearningEntry[] {
  return entries
    .filter((e) => e.severity !== "negative")
    .slice()
    .sort((a, b) => {
      if (b.reinforcementCount !== a.reinforcementCount) {
        return b.reinforcementCount - a.reinforcementCount;
      }
      return b.confidence - a.confidence;
    })
    .slice(0, n);
}

/**
 * Entries nearest their decay-based expiry, surfaced so the user can give
 * feedback before they drop below the confidence threshold. Uses the same
 * exponential-decay curve as the selector: days until `confidence` falls to
 * `confidenceThreshold` equals `ln(confidence / threshold) / decayRate`.
 */
export function nearExpiry(
  entries: LearningEntry[],
  n: number,
  config: Pick<ResolvedLearningsConfig, "confidenceThreshold" | "decayRate">,
  now: Date = new Date(),
): LearningEntry[] {
  const threshold = Math.max(config.confidenceThreshold, 0.0001);
  const rate = Math.max(config.decayRate, 0.0001);

  const scored = entries
    .filter((e) => e.severity !== "negative")
    .filter((e) => !e.expiresAt || new Date(e.expiresAt) > now)
    .filter((e) => e.confidence > threshold)
    .map((entry) => {
      const last = new Date(entry.lastSeenAt).getTime();
      const ageDays = Math.max(0, (now.getTime() - last) / MS_PER_DAY);
      const currentConfidence = entry.confidence * Math.exp(-ageDays * rate);
      const daysToExpiry = currentConfidence <= threshold ? 0 : Math.log(currentConfidence / threshold) / rate;
      return { entry, daysToExpiry };
    });

  scored.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  return scored.slice(0, n).map((s) => s.entry);
}

/** Count of negative-severity entries (false-positive patterns rejected). */
export function negativeCount(entries: LearningEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.severity === "negative") count += 1;
  }
  return count;
}
