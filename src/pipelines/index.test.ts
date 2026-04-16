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

  it("includes the investigate pipeline", () => {
    const investigate = builtinPipelines.find((pipeline) => pipeline.name === "investigate");

    expect(investigate).toBeDefined();
    expect(investigate?.stages).toHaveLength(1);
    expect(investigate?.stages[0]).toMatchObject({
      id: "investigate",
      agent: "investigator",
      completion: "idle",
      fork: false,
    });
  });

  it("includes the standalone review pipeline that posts PR comments", () => {
    const review = builtinPipelines.find((p) => p.name === "review");

    expect(review).toBeDefined();
    expect(review?.stages).toHaveLength(3);
    expect(review?.stages[0]).toMatchObject({
      id: "code-review",
      agent: "code-reviewer",
      completion: "tool_signal",
      fork: false,
    });
    expect(review?.stages[1]).toMatchObject({
      id: "review-judge",
      agent: "pr-review-judge",
      completion: "tool_signal",
      fork: true,
    });
    expect(review?.stages[2]).toMatchObject({
      id: "post-comments",
      agent: "pr-commenter",
      completion: "tool_signal",
      fork: true,
    });
  });

  it("includes the internal review-loop pipeline used by /implement", () => {
    const reviewLoop = builtinPipelines.find((p) => p.name === "review-loop");

    expect(reviewLoop).toBeDefined();
    expect(reviewLoop?.stages).toHaveLength(2);
    expect(reviewLoop?.stages[0]).toMatchObject({
      id: "code-review",
      agent: "code-reviewer",
    });
    expect(reviewLoop?.stages[1]).toMatchObject({
      id: "review-judge",
      agent: "review-judge",
    });
  });

  it("implement refs the internal review-loop (not standalone review)", () => {
    const implement = builtinPipelines.find((p) => p.name === "implement");

    expect(implement).toBeDefined();
    const lastStage = implement?.stages[implement.stages.length - 1];
    expect(lastStage).toMatchObject({ type: "pipeline", pipeline: "review-loop" });
  });

  it("includes the create-jira-issues pipeline", () => {
    const createJira = builtinPipelines.find((pipeline) => pipeline.name === "create-jira-issues");

    expect(createJira).toBeDefined();
    expect(createJira?.stages).toHaveLength(2);
    expect(createJira?.stages[0]).toMatchObject({
      id: "draft",
      agent: "jira-planner",
      completion: "tool_signal",
      fork: false,
    });
    expect(createJira?.stages[1]).toMatchObject({
      id: "create",
      agent: "jira-planner",
      completion: "tool_signal",
      fork: true,
    });
  });
});
