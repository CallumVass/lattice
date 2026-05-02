import { describe, expect, it } from "vitest";
import { AgentTracker, bindActiveStageSkillsToSession, buildSystemTransform, SkillStore } from "./system-transform.js";

describe("buildSystemTransform", () => {
  it("does nothing without a session id", async () => {
    const tracker = new AgentTracker();
    const skillStore = new SkillStore();
    const transform = buildSystemTransform({}, tracker, skillStore);
    const output = { system: ["base"] };

    await transform({ model: { id: "x", providerID: "y" } }, output);

    expect(output.system).toEqual(["base"]);
  });

  it("injects agent prompt suffix and loaded skills for the tracked session", async () => {
    const tracker = new AgentTracker();
    const skillStore = new SkillStore();
    tracker.track("session-1", "implementor");
    skillStore.set("session-1", [
      {
        name: "tdd",
        description: "Test-first workflow",
        content: "Write failing tests first.",
        filePath: "/tmp/tdd.md",
      },
      {
        name: "docs",
        description: "Docs workflow",
        content: "Update README when behavior changes.",
        filePath: "/tmp/docs.md",
      },
    ]);
    const transform = buildSystemTransform(
      {
        agents: {
          implementor: { promptSuffix: "Keep diffs minimal." },
        },
      },
      tracker,
      skillStore,
    );
    const output = { system: [] as string[] };

    await transform({ sessionID: "session-1", model: { id: "x", providerID: "y" } }, output);

    expect(output.system).toEqual([
      "Keep diffs minimal.",
      "## Loaded Skills\n\n### Skill: tdd\nWrite failing tests first.\n\n### Skill: docs\nUpdate README when behavior changes.",
    ]);
  });

  it("copies stage-selected skills onto the actual session", () => {
    const skillStore = new SkillStore();
    skillStore.setStage("run-1:implement", [
      {
        name: "tdd",
        description: "Test-first workflow",
        content: "Write failing tests first.",
        filePath: "/tmp/tdd.md",
      },
    ]);

    skillStore.applyStageToSession("run-1:implement", "child-session");

    expect(skillStore.get("child-session").map((s) => s.name)).toEqual(["tdd"]);
  });

  it("binds active stage skills only for the matching running agent", () => {
    const skillStore = new SkillStore();
    skillStore.setStage("run-1:implement", [
      {
        name: "tdd",
        description: "Test-first workflow",
        content: "Write failing tests first.",
        filePath: "/tmp/tdd.md",
      },
    ]);
    const instance = {
      id: "run-1",
      pipelineName: "sample",
      goal: "ship it",
      status: "running" as const,
      currentStageIndex: 0,
      stages: [{ id: "implement", agent: "implementor", status: "running" as const }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    bindActiveStageSkillsToSession(skillStore, instance, "child-session", "implementor");
    bindActiveStageSkillsToSession(skillStore, instance, "other-session", "reviewer");

    expect(skillStore.get("child-session").map((s) => s.name)).toEqual(["tdd"]);
    expect(skillStore.get("other-session")).toEqual([]);
  });

  it("clears stale session skills when a stage has none", () => {
    const skillStore = new SkillStore();
    skillStore.set("session-1", [
      {
        name: "tdd",
        description: "Test-first workflow",
        content: "Write failing tests first.",
        filePath: "/tmp/tdd.md",
      },
    ]);

    skillStore.set("session-1", []);

    expect(skillStore.get("session-1")).toEqual([]);
  });
});
