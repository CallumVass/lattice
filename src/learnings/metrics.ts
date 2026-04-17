import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { extractFromFindings } from "./extractor.js";

const DEFAULT_METRICS_PATH = ".lattice/metrics.jsonl";

interface MetricsOptions {
  projectDir: string;
  metricsPath?: string;
}

export interface RunMetrics {
  instance: string;
  pipeline: string;
  findingsCount: number;
  byCategory: Record<string, number>;
  learningsInjected: number;
  timestamp: string;
}

function resolvePath(opts: MetricsOptions): string {
  const p = opts.metricsPath ?? DEFAULT_METRICS_PATH;
  return isAbsolute(p) ? p : join(opts.projectDir, p);
}

export async function recordRun(run: RunMetrics, opts: MetricsOptions): Promise<void> {
  const path = resolvePath(opts);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(run)}\n`);
}

export async function readAll(opts: MetricsOptions): Promise<RunMetrics[]> {
  const path = resolvePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const rows: RunMetrics[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as RunMetrics);
    } catch {
      // skip malformed
    }
  }
  return rows;
}

/**
 * Summarize a FINDINGS report into a `{findingsCount, byCategory}` shape,
 * reusing the same parser that feeds capture.
 */
export function summarizeFindings(text: string | undefined): {
  findingsCount: number;
  byCategory: Record<string, number>;
} {
  const entries = text ? extractFromFindings(text, { stageId: "metrics" }) : [];
  const byCategory: Record<string, number> = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }
  return { findingsCount: entries.length, byCategory };
}

/**
 * Average a numeric metric across the last `n` recorded runs. Returns
 * `undefined` when no runs are recorded yet so callers can suppress the
 * surface rather than render `NaN` / `0.0` for a never-used feature.
 */
export async function trailingAverage(
  field: keyof RunMetrics,
  n: number,
  opts: MetricsOptions,
): Promise<number | undefined> {
  const rows = await readAll(opts);
  if (rows.length === 0) return undefined;
  const slice = rows.slice(-n);
  let sum = 0;
  let count = 0;
  for (const row of slice) {
    const value = row[field];
    if (typeof value === "number") {
      sum += value;
      count += 1;
    }
  }
  if (count === 0) return undefined;
  return sum / count;
}
