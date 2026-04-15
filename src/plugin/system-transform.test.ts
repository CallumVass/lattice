import { describe, expect, it } from "vitest";
import { AgentTracker, buildSystemTransform, SkillStore } from "./system-transform.js";

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
});
