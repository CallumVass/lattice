import { describe, expect, it } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import { composePrompt } from "./prompt.js";

describe("composePrompt", () => {
  it("enumerates only declared signals in the tool_signal block", () => {
    const p = pipeline("review", {
      stages: [stage("judge", { agent: "judge", completion: "tool_signal", signals: ["approve", "reject"] })],
    });
    const prompt = composePrompt({
      goal: "Review PR #42",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain('lattice_signal(status: "approve"');
    expect(prompt).toContain('lattice_signal(status: "reject"');
    expect(prompt).not.toContain('lattice_signal(status: "complete"');
    expect(prompt).not.toContain('lattice_signal(status: "blocked"');
    expect(prompt).toContain("Valid outcomes for this stage are:");
  });

  it("says 'only valid outcome' when a single signal is declared", () => {
    const p = pipeline("work", {
      stages: [stage("do-it", { agent: "worker", completion: "tool_signal", signals: ["complete"] })],
    });
    const prompt = composePrompt({
      goal: "work",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain("The only valid outcome for this stage is:");
    expect(prompt).toContain('lattice_signal(status: "complete"');
    expect(prompt).not.toContain('lattice_signal(status: "approve"');
  });

  it("omits the tool_signal block for idle stages", () => {
    const p = pipeline("simple", {
      stages: [stage("refactor", { agent: "refactorer", completion: "idle" })],
    });
    const prompt = composePrompt({
      goal: "refactor",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).not.toContain("lattice_signal");
  });

  it("substitutes {{goal}} inside the stage prompt", () => {
    const p = pipeline("x", {
      stages: [
        stage("s", {
          agent: "a",
          completion: "tool_signal",
          signals: ["complete"],
          prompt: "Work on {{goal}} now.",
        }),
      ],
    });
    const prompt = composePrompt({
      goal: "feature-42",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain("Work on feature-42 now.");
  });
});
