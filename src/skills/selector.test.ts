import { describe, expect, it, vi } from "vitest";
import type { DiscoveredSkill } from "./scanner.js";
import type { ScoringProvider } from "./scorer.js";
import { selectSkills } from "./selector.js";

function skill(name: string): DiscoveredSkill {
  return { name, description: "", filePath: `/tmp/${name}.md`, content: "" };
}

const noopProvider: ScoringProvider = { scoreSkills: async () => "[]" };

const ctx = { goal: "g", agent: "a", stageId: "s", defaultMax: 4 } as const;

describe("selectSkills", () => {
  it("returns empty when stage has no skills config", async () => {
    const result = await selectSkills([skill("tdd")], { ...ctx, skillsConfig: undefined }, noopProvider);
    expect(result).toEqual([]);
  });

  it("returns empty when stage is neither dynamic nor has pins", async () => {
    const result = await selectSkills(
      [skill("tdd")],
      { ...ctx, skillsConfig: { dynamic: false, pinned: [], max: 4 } },
      noopProvider,
    );
    expect(result).toEqual([]);
  });

  it("filters to pinned skills when dynamic is off", async () => {
    const result = await selectSkills(
      [skill("tdd"), skill("code-review"), skill("unused")],
      { ...ctx, skillsConfig: { dynamic: false, pinned: ["tdd", "code-review"], max: 4 } },
      noopProvider,
    );
    expect(result.map((s) => s.name)).toEqual(["tdd", "code-review"]);
  });

  it("delegates to the scoring provider when dynamic is on", async () => {
    const provider: ScoringProvider = { scoreSkills: vi.fn(async () => "[1]") };
    const result = await selectSkills(
      [skill("tdd"), skill("code-review")],
      { ...ctx, skillsConfig: { dynamic: true, pinned: [], max: 2 } },
      provider,
    );
    expect(provider.scoreSkills).toHaveBeenCalledOnce();
    expect(result.map((s) => s.name)).toEqual(["tdd"]);
  });

  it("falls back to pins when dynamic is on but no skills were discovered", async () => {
    const provider: ScoringProvider = { scoreSkills: vi.fn(async () => "[1]") };
    const result = await selectSkills(
      [],
      { ...ctx, skillsConfig: { dynamic: true, pinned: ["tdd"], max: 4 } },
      provider,
    );
    expect(provider.scoreSkills).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("falls back to defaultMax when skillsConfig.max is absent", async () => {
    const provider: ScoringProvider = {
      scoreSkills: vi.fn(async (prompt) => {
        expect(prompt).toContain("Maximum 2 skills");
        return "[]";
      }),
    };
    await selectSkills(
      [skill("a"), skill("b"), skill("c")],
      {
        ...ctx,
        defaultMax: 2,
        skillsConfig: { dynamic: true, pinned: [], max: undefined as unknown as number },
      },
      provider,
    );
    expect(provider.scoreSkills).toHaveBeenCalledOnce();
  });
});
