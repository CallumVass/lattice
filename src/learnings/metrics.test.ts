import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunMetrics, readAll, recordRun, summarizeFindings, trailingAverage } from "./metrics.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-metrics-${Date.now()}-${Math.random()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function fixture(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    instance: "run-1",
    pipeline: "review",
    findingsCount: 2,
    byCategory: { auth: 1, perf: 1 },
    learningsInjected: 3,
    timestamp: "2026-04-17T12:00:00.000Z",
    ...overrides,
  };
}

describe("recordRun + readAll", () => {
  it("appends one line per run and reads them back", async () => {
    await recordRun(fixture({ instance: "a" }), { projectDir });
    await recordRun(fixture({ instance: "b", findingsCount: 5 }), { projectDir });

    const rows = await readAll({ projectDir });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.instance).toBe("a");
    expect(rows[1]?.findingsCount).toBe(5);
  });

  it("creates the parent directory if missing", async () => {
    await recordRun(fixture(), { projectDir, metricsPath: "nested/dir/metrics.jsonl" });
    const raw = await readFile(join(projectDir, "nested/dir/metrics.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("readAll returns [] when the file does not exist", async () => {
    expect(await readAll({ projectDir })).toEqual([]);
  });

  it("readAll skips malformed lines", async () => {
    const path = join(projectDir, ".lattice/metrics.jsonl");
    await mkdir(join(projectDir, ".lattice"), { recursive: true });
    await writeFile(path, `${JSON.stringify(fixture())}\nnot-json\n${JSON.stringify(fixture({ instance: "c" }))}\n`);
    const rows = await readAll({ projectDir });
    expect(rows).toHaveLength(2);
  });
});

describe("trailingAverage", () => {
  it("returns undefined when no runs are recorded", async () => {
    expect(await trailingAverage("findingsCount", 5, { projectDir })).toBeUndefined();
  });

  it("averages the last n entries only", async () => {
    for (const count of [10, 10, 10, 2, 4]) {
      await recordRun(fixture({ findingsCount: count }), { projectDir });
    }
    const avg = await trailingAverage("findingsCount", 2, { projectDir });
    expect(avg).toBe(3);
  });

  it("returns the overall mean when fewer runs than n", async () => {
    await recordRun(fixture({ findingsCount: 4 }), { projectDir });
    await recordRun(fixture({ findingsCount: 6 }), { projectDir });
    const avg = await trailingAverage("findingsCount", 5, { projectDir });
    expect(avg).toBe(5);
  });
});

describe("summarizeFindings", () => {
  it("counts findings and groups them by derived category", () => {
    const text = `FINDINGS

## Blocking

### Finding: Null check missing
- **File**: \`src/auth/login.ts:42\`
- **Severity**: critical
- **Confidence**: 95
- **Issue**: user is null

### Finding: SQL injection
- **File**: \`src/db/users.ts:118\`
- **Severity**: high
- **Confidence**: 90
- **Issue**: id is interpolated
`;
    const summary = summarizeFindings(text);
    expect(summary.findingsCount).toBe(2);
    expect(summary.byCategory).toEqual({ auth: 1, db: 1 });
  });

  it("returns zeroes for undefined / NO_FINDINGS", () => {
    expect(summarizeFindings(undefined)).toEqual({ findingsCount: 0, byCategory: {} });
    expect(summarizeFindings("NO_FINDINGS")).toEqual({ findingsCount: 0, byCategory: {} });
  });
});
