import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPipelines } from "./loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lattice-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadPipelines", () => {
  it("returns empty registry for missing directory", async () => {
    const registry = await loadPipelines("/nonexistent");
    expect(registry.size).toBe(0);
  });

  it("loads a valid pipeline file", async () => {
    await writeFile(
      join(dir, "review.ts"),
      `export default {
        name: "review",
        stages: [
          { id: "code-review", type: "stage", agent: "code-reviewer", completion: "tool_signal", fork: false },
        ],
      };`,
    );

    const registry = await loadPipelines(dir);
    expect(registry.size).toBe(1);
    expect(registry.get("review")?.name).toBe("review");
  });

  it("throws on missing default export", async () => {
    await writeFile(join(dir, "bad.ts"), "export const foo = 1;");

    await expect(loadPipelines(dir)).rejects.toThrow("must have a default export");
  });

  it("throws on invalid pipeline definition", async () => {
    await writeFile(join(dir, "bad.ts"), 'export default { name: "INVALID NAME!", stages: [] };');

    await expect(loadPipelines(dir)).rejects.toThrow("Invalid pipeline definition");
  });

  it("user pipelines override builtins with same name", async () => {
    await writeFile(
      join(dir, "review.ts"),
      `export default {
        name: "review",
        description: "custom review",
        stages: [
          { id: "custom-review", type: "stage", agent: "custom-reviewer", completion: "idle", fork: false },
        ],
      };`,
    );

    const builtins = [
      {
        name: "review",
        stages: [
          { id: "builtin-review", type: "stage" as const, agent: "builtin", completion: "idle" as const, fork: false },
        ],
      },
    ];

    const registry = await loadPipelines(dir, builtins);
    expect(registry.get("review")?.description).toBe("custom review");
  });
});
