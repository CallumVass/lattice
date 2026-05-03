import { describe, expect, it } from "vitest";
import { parallel, ref, stage } from "./stage.js";

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
      completedContext: "full",
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

  it("creates a stage with compact completed context", () => {
    const s = stage("implement", {
      agent: "implementor",
      completion: "signal",
      signals: ["complete"],
      completedContext: "summaries",
    });

    expect(s.completedContext).toBe("summaries");
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

  it("creates a stage with dynamic expansion config", () => {
    const s = stage("build-slices", {
      agent: "implementor",
      completion: "signal",
      signals: ["complete", "blocked"],
      expand: {
        from: ".lattice/slices.json",
        arrayPath: "slices",
        maxItems: 8,
        template: {
          id: "build-{{position}}-{{id}}",
          type: "stage",
          agent: "implementor",
          completion: "signal",
          signals: ["complete", "blocked"],
          context: "isolated",
        },
      },
    });

    expect(s.expand).toEqual({
      from: ".lattice/slices.json",
      arrayPath: "slices",
      maxItems: 8,
      template: {
        id: "build-{{position}}-{{id}}",
        type: "stage",
        agent: "implementor",
        completion: "signal",
        signals: ["complete", "blocked"],
        context: "isolated",
      },
    });
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

describe("parallel", () => {
  it("creates a parallel stage group", () => {
    const group = parallel("reviewers", {
      stages: [
        stage("security", { agent: "security-reviewer", completion: "signal", signals: ["complete"] }),
        stage("quality", { agent: "quality-reviewer", completion: "signal", signals: ["complete"] }),
      ],
      maxConcurrency: 2,
    });

    expect(group.type).toBe("parallel");
    expect(group.id).toBe("reviewers");
    expect(group.maxConcurrency).toBe(2);
    expect(group.stages.map((s) => s.id)).toEqual(["security", "quality"]);
  });

  it("rejects shared-context parallel stages", () => {
    expect(() =>
      parallel("reviewers", {
        stages: [
          stage("security", {
            agent: "security-reviewer",
            completion: "signal",
            signals: ["complete"],
            context: "shared",
          }),
        ],
      }),
    ).toThrow("Parallel stages must use isolated context");
  });
});
