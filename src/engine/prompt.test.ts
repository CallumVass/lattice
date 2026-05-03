import { describe, expect, it } from "vitest";
import { pipeline, stage } from "../builder/index.js";
import { composePrompt } from "./prompt.js";

describe("composePrompt", () => {
  it("enumerates only declared signals in the signal block", () => {
    const p = pipeline("review", {
      stages: [stage("judge", { agent: "judge", completion: "signal", signals: ["pass", "fail"] })],
    });
    const prompt = composePrompt({
      goal: "Review PR #42",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain('lattice_signal(status: "pass"');
    expect(prompt).toContain('lattice_signal(status: "fail"');
    expect(prompt).not.toContain('lattice_signal(status: "complete"');
    expect(prompt).not.toContain('lattice_signal(status: "blocked"');
    expect(prompt).toContain("Valid outcomes for this stage are:");
  });

  it("says 'only valid outcome' when a single signal is declared", () => {
    const p = pipeline("work", {
      stages: [stage("do-it", { agent: "worker", completion: "signal", signals: ["complete"] })],
    });
    const prompt = composePrompt({
      goal: "work",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain("The only valid outcome for this stage is:");
    expect(prompt).toContain('lattice_signal(status: "complete"');
    expect(prompt).not.toContain('lattice_signal(status: "pass"');
  });

  it("omits the signal block for idle stages", () => {
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

  it("substitutes every {{goal}} inside the stage prompt", () => {
    const p = pipeline("x", {
      stages: [
        stage("s", {
          agent: "a",
          completion: "signal",
          signals: ["complete"],
          prompt: "Work on {{goal}} now. Then verify {{goal}}.",
        }),
      ],
    });
    const prompt = composePrompt({
      goal: "feature-42",
      completedStages: [],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain("Work on feature-42 now. Then verify feature-42.");
  });

  it("omits completed stages when completedContext is none", () => {
    const p = pipeline("slice", {
      stages: [
        stage("build-slice", {
          agent: "worker",
          completion: "signal",
          signals: ["complete"],
          completedContext: "none",
        }),
      ],
    });
    const prompt = composePrompt({
      goal: "work",
      completedStages: [{ id: "plan", agent: "planner", status: "completed", summary: "secret summary" }],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).not.toContain("## Completed Stages");
    expect(prompt).not.toContain("secret summary");
  });

  it("renders compact completed stages when completedContext is summaries", () => {
    const p = pipeline("integration", {
      stages: [
        stage("final", {
          agent: "worker",
          completion: "signal",
          signals: ["complete"],
          completedContext: "summaries",
        }),
      ],
    });
    const prompt = composePrompt({
      goal: "work",
      completedStages: [{ id: "plan", agent: "planner", status: "completed", summary: "planned" }],
      currentStage: p.stages[0] as Extract<(typeof p.stages)[number], { type: "stage" }>,
    });

    expect(prompt).toContain("- **plan**: planned");
    expect(prompt).not.toContain("(planner): planned");
  });
});
