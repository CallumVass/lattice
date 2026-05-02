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
    const registry = await loadPipelines(["/nonexistent"]);
    expect(registry.size).toBe(0);
  });

  it("loads a valid pipeline file", async () => {
    await writeFile(
      join(dir, "review.ts"),
      `export default {
        name: "review",
        stages: [
          { id: "code-review", type: "stage", agent: "code-reviewer", completion: "signal", signals: ["complete"], context: "isolated" },
        ],
      };`,
    );

    const registry = await loadPipelines([dir]);
    expect(registry.size).toBe(1);
    expect(registry.get("review")?.name).toBe("review");
  });

  it("skips files with missing default export and reports diagnostics", async () => {
    await writeFile(join(dir, "bad.ts"), "export const foo = 1;");

    const diagnostics: string[] = [];
    const registry = await loadPipelines([dir], { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message) });

    expect(registry.size).toBe(0);
    expect(diagnostics.join("\n")).toContain("must have a default export");
  });

  it("skips invalid pipeline definitions and reports diagnostics", async () => {
    await writeFile(join(dir, "bad.ts"), 'export default { name: "INVALID NAME!", stages: [] };');

    const diagnostics: string[] = [];
    const registry = await loadPipelines([dir], { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message) });

    expect(registry.size).toBe(0);
    expect(diagnostics.join("\n")).toContain("Invalid pipeline definition");
  });

  it("later directories override earlier ones with the same pipeline name", async () => {
    const globalDir = await mkdtemp(join(tmpdir(), "lattice-global-"));
    try {
      await writeFile(
        join(globalDir, "review.ts"),
        `export default {
          name: "review",
          description: "global review",
          stages: [
            { id: "global-review", type: "stage", agent: "reviewer", completion: "idle", context: "isolated" },
          ],
        };`,
      );
      await writeFile(
        join(dir, "review.ts"),
        `export default {
          name: "review",
          description: "project review",
          stages: [
            { id: "project-review", type: "stage", agent: "reviewer", completion: "idle", context: "isolated" },
          ],
        };`,
      );

      const registry = await loadPipelines([globalDir, dir]);
      expect(registry.get("review")?.description).toBe("project review");
    } finally {
      await rm(globalDir, { recursive: true, force: true });
    }
  });
});
