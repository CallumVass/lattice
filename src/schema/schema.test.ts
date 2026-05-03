import { describe, expect, it } from "vitest";
import { latticeConfigSchema, pipelineDefinitionSchema } from "./index.js";

describe("public schemas", () => {
  it("rejects unknown pipeline keys", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "review",
      description: "Review changes",
      stages: [{ type: "stage", id: "run", agent: "reviewer", completion: "idle" }],
      command: "review-now",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown stage keys", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "review",
      stages: [
        {
          type: "stage",
          id: "run",
          agent: "reviewer",
          completion: "idle",
          skillz: { pinned: ["security"] },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown config keys", () => {
    const result = latticeConfigSchema.safeParse({
      skills: {
        max: 3,
        disable: true,
      },
    });

    expect(result.success).toBe(false);
  });
});
