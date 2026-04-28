import { describe, expect, it } from "vitest";
import { pipeline } from "./pipeline.js";
import { ref, stage } from "./stage.js";

describe("pipeline", () => {
  it("creates a pipeline definition", () => {
    const p = pipeline("implement", {
      description: "TDD implementation pipeline",
      stages: [
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
        stage("implement", { agent: "implementor", completion: "signal", signals: ["complete"], context: "shared" }),
      ],
    });

    expect(p.name).toBe("implement");
    expect(p.description).toBe("TDD implementation pipeline");
    expect(p.stages).toHaveLength(2);
  });

  it("supports pipeline composition via ref", () => {
    const p = pipeline("implement", {
      stages: [
        stage("plan", { agent: "planner", completion: "signal", signals: ["complete"] }),
        stage("implement", { agent: "implementor", completion: "signal", signals: ["complete"], context: "shared" }),
        ref("review"),
      ],
    });

    expect(p.stages).toHaveLength(3);
    expect(p.stages[2]).toEqual({ type: "pipeline", pipeline: "review" });
  });

  it("omits description when not provided", () => {
    const p = pipeline("review", {
      stages: [stage("code-review", { agent: "code-reviewer", completion: "signal", signals: ["complete"] })],
    });

    expect(p.description).toBeUndefined();
  });
});
