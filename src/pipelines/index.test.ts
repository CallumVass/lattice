import { describe, expect, it } from "vitest";
import { builtinPipelines } from "./index.js";

describe("builtinPipelines", () => {
  it("includes the architecture pipeline", () => {
    const architecture = builtinPipelines.find((pipeline) => pipeline.name === "architecture");

    expect(architecture).toBeDefined();
    expect(architecture?.stages).toHaveLength(1);
    expect(architecture?.stages[0]).toMatchObject({
      id: "architecture-review",
      agent: "architecture-reviewer",
      completion: "tool_signal",
      fork: false,
    });
  });
});
