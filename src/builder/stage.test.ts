import { describe, expect, it } from "vitest";
import { ref, stage } from "./stage.js";

describe("stage", () => {
  it("creates a stage with defaults", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "signal",
      signals: ["complete"],
    });

    expect(s).toEqual({
      id: "plan",
      type: "stage",
      agent: "planner",
      completion: "signal",
      signals: ["complete"],
      context: "isolated",
      pauseAfter: false,
      isRewindTarget: false,
    });
  });

  it("creates a stage with isRewindTarget and maxRewinds", () => {
    const s = stage("author", {
      agent: "ticket-author",
      completion: "signal",
      signals: ["complete"],
      isRewindTarget: true,
      maxRewinds: 2,
    });

    expect(s.isRewindTarget).toBe(true);
    expect(s.maxRewinds).toBe(2);
  });

  it("omits maxRewinds when undefined", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "signal",
      signals: ["complete"],
    });

    expect("maxRewinds" in s).toBe(false);
  });

  it("creates a shared-context stage", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "signal",
      signals: ["complete"],
      context: "shared",
    });

    expect(s.context).toBe("shared");
  });

  it("creates a stage with skills", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "signal",
      signals: ["complete"],
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
      completion: "signal",
      signals: ["complete"],
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
