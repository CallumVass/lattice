import { describe, expect, it } from "vitest";
import { ref, stage } from "./stage.js";

describe("stage", () => {
  it("creates a stage with defaults", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "plan_created",
    });

    expect(s).toEqual({
      id: "plan",
      type: "stage",
      agent: "planner",
      completion: "plan_created",
      fork: false,
      pauseAfter: false,
    });
  });

  it("creates a forked stage", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "plan_complete",
      fork: true,
    });

    expect(s.fork).toBe(true);
  });

  it("creates a stage with skills", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "plan_created",
      skills: { dynamic: true, pinned: ["tdd"] },
    });

    expect(s.skills).toEqual({
      dynamic: true,
      pinned: ["tdd"],
      max: 4,
    });
  });

  it("creates a stage with custom prompt", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "plan_created",
      prompt: "Plan the implementation of {{goal}}",
    });

    expect(s.prompt).toBe("Plan the implementation of {{goal}}");
  });
});

describe("ref", () => {
  it("creates a pipeline reference", () => {
    const r = ref("review");

    expect(r).toEqual({
      type: "pipeline",
      pipeline: "review",
    });
  });
});
