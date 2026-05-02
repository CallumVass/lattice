import { describe, expect, it } from "vitest";
import { pauseInstruction, pauseMessage } from "./notifications.js";

describe("pauseMessage", () => {
  it("asks a compact checkpoint question with optional guidance", () => {
    const message = pauseMessage("ship", {
      kind: "checkpoint",
      stageId: "plan",
      nextStageId: "build",
      reason: 'Stage "plan" complete. Waiting for user approval before running "build".',
    });

    expect(message).toContain("Lattice needs your decision.");
    expect(message).toContain("Pipeline: ship");
    expect(message).toContain("State: checkpoint");
    expect(message).toContain("OpenCode will ask what Lattice should do next and let you add optional guidance.");
    expect(message).not.toContain("Question 1 header: Action");
    expect(message).not.toContain("Assistant action");
    expect(message).not.toContain("###");
    expect(message).not.toContain("permission");

    const instruction = pauseInstruction("ship", {
      kind: "checkpoint",
      stageId: "plan",
      nextStageId: "build",
      reason: 'Stage "plan" complete. Waiting for user approval before running "build".',
    });

    expect(instruction).toContain("Question 1 header: Action");
    expect(instruction).toContain(
      'Continue -> lattice_control action "continue"; pass extra guidance as response when provided.',
    );
    expect(instruction).toContain("Question 2 text: Any extra guidance?");
    expect(instruction).toContain("No extra guidance");
  });

  it("offers retry and accept choices for blocked pauses", () => {
    const message = pauseMessage("review", {
      kind: "blocked",
      stageId: "verify",
      reason: "Missing dependency DATABASE_URL",
    });

    expect(message).toContain("State: blocked");
    expect(message).toContain("Context: Missing dependency DATABASE_URL");
    const instruction = pauseInstruction("review", {
      kind: "blocked",
      stageId: "verify",
      reason: "Missing dependency DATABASE_URL",
    });

    expect(instruction).toContain(
      'Retry -> lattice_control action "retry"; pass extra guidance as response when provided.',
    );
    expect(instruction).toContain(
      'Accept and continue -> lattice_control action "accept"; pass extra guidance as reason when provided.',
    );
  });

  it("normalizes and truncates long markdown context", () => {
    const longContext = `# Plan

**Important**: run \`npm run check\`.

${"x".repeat(1_200)}`;
    const message = pauseMessage("impl", {
      kind: "checkpoint",
      stageId: "plan",
      prompt: longContext,
    });

    expect(message).toContain("Context: Plan");
    expect(message).toContain("Important: run npm run check.");
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("x".repeat(1_000));
  });
});
