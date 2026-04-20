import { describe, expect, it } from "vitest";
import { ref, stage } from "./stage.js";

describe("stage", () => {
  it("creates a stage with defaults", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "tool_signal",
      signals: ["complete"],
    });

    expect(s).toEqual({
      id: "plan",
      type: "stage",
      agent: "planner",
      completion: "tool_signal",
      signals: ["complete"],
      fork: false,
      pauseAfter: false,
    });
  });

  it("creates a forked stage", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete"],
      fork: true,
    });

    expect(s.fork).toBe(true);
  });

  it("creates a stage with skills", () => {
    const s = stage("plan", {
      agent: "planner",
      completion: "tool_signal",
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
      completion: "tool_signal",
      signals: ["complete"],
      prompt: "Plan the implementation of {{goal}}",
    });

    expect(s.prompt).toBe("Plan the implementation of {{goal}}");
  });

  it("creates a stage with a post-hook and default retries", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete"],
      postHook: { commands: ["npm run check"] },
    });

    expect(s.postHook).toEqual({ commands: ["npm run check"], maxRetries: 1 });
  });

  it("honours an explicit post-hook maxRetries", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete"],
      postHook: { commands: ["lint", "test"], maxRetries: 3 },
    });

    expect(s.postHook).toEqual({ commands: ["lint", "test"], maxRetries: 3 });
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
