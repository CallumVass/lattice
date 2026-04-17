import { describe, expect, it } from "vitest";
import { pipeline, ref, stage } from "../builder/index.js";
import { flattenPipeline } from "./flattener.js";
import type { PipelineRegistry } from "./loader.js";

function registryOf(...defs: ReturnType<typeof pipeline>[]): PipelineRegistry {
  const reg: PipelineRegistry = new Map();
  for (const d of defs) {
    reg.set(d.name, d);
  }
  return reg;
}

describe("flattenPipeline", () => {
  it("passes through stages unchanged", () => {
    const p = pipeline("review", {
      stages: [
        stage("code-review", { agent: "code-reviewer", completion: "tool_signal" }),
        stage("review-judge", { agent: "review-judge", completion: "tool_signal", fork: true }),
      ],
    });

    const flat = flattenPipeline(p, registryOf(p));

    expect(flat.stages).toHaveLength(2);
    expect(flat.stages.map((s) => s.id)).toEqual(["code-review", "review-judge"]);
  });

  it("inlines pipeline references", () => {
    const review = pipeline("review", {
      stages: [
        stage("code-review", { agent: "code-reviewer", completion: "tool_signal" }),
        stage("review-judge", { agent: "review-judge", completion: "tool_signal", fork: true }),
      ],
    });

    const implement = pipeline("implement", {
      stages: [
        stage("plan", { agent: "planner", completion: "tool_signal" }),
        stage("implement", { agent: "implementor", completion: "tool_signal", fork: true }),
        ref("review"),
      ],
    });

    const registry = registryOf(review, implement);
    const flat = flattenPipeline(implement, registry);

    expect(flat.stages).toHaveLength(4);
    expect(flat.stages.map((s) => s.id)).toEqual(["plan", "implement", "code-review", "review-judge"]);
  });

  it("detects circular references", () => {
    const a = pipeline("a", { stages: [ref("b")] });
    const b = pipeline("b", { stages: [ref("a")] });

    const registry = registryOf(a, b);

    expect(() => flattenPipeline(a, registry)).toThrow("Circular pipeline reference");
  });

  it("detects self-references", () => {
    const p = pipeline("self", { stages: [ref("self")] });

    expect(() => flattenPipeline(p, registryOf(p))).toThrow("Circular pipeline reference");
  });

  it("throws on missing pipeline ref", () => {
    const p = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "tool_signal" }), ref("nonexistent")],
    });

    expect(() => flattenPipeline(p, registryOf(p))).toThrow('"nonexistent" not found');
  });

  it("handles multi-level nesting", () => {
    const lint = pipeline("lint", {
      stages: [stage("lint-check", { agent: "linter", completion: "idle" })],
    });

    const review = pipeline("review", {
      stages: [ref("lint"), stage("code-review", { agent: "code-reviewer", completion: "tool_signal" })],
    });

    const implement = pipeline("implement", {
      stages: [stage("plan", { agent: "planner", completion: "tool_signal" }), ref("review")],
    });

    const registry = registryOf(lint, review, implement);
    const flat = flattenPipeline(implement, registry);

    expect(flat.stages.map((s) => s.id)).toEqual(["plan", "lint-check", "code-review"]);
  });
});
