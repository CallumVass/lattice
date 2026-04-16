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
