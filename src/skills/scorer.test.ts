import { describe, expect, it } from "vitest";
import type { DiscoveredSkill } from "./scanner.js";
import type { ScoringProvider } from "./scorer.js";
import { scoreSkills } from "./scorer.js";

function skill(name: string, description = ""): DiscoveredSkill {
  return { name, description, filePath: `/skills/${name}.md`, content: `# ${name}` };
}

const ctx = { goal: "implement auth flow", agent: "implementor", stageId: "implement" };

describe("scoreSkills", () => {
  it("returns pinned skills even without LLM call", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[]" };
    const skills = [skill("tdd"), skill("auth"), skill("react")];

    const result = await scoreSkills(skills, ctx, ["tdd"], 4, provider);

    expect(result.map((s) => s.name)).toEqual(["tdd"]);
  });

  it("returns only pinned when max is reached", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[1, 2]" };
    const skills = [skill("tdd"), skill("auth"), skill("react")];

    const result = await scoreSkills(skills, ctx, ["tdd", "auth"], 2, provider);

    expect(result.map((s) => s.name)).toEqual(["tdd", "auth"]);
  });

  it("selects LLM-recommended skills after pinned", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[2, 1]" };
    const skills = [skill("tdd"), skill("auth"), skill("react")];

    const result = await scoreSkills(skills, ctx, ["tdd"], 3, provider);

    // pinned: tdd. Candidates: auth(1), react(2). LLM says [2, 1] = react, auth
    expect(result.map((s) => s.name)).toEqual(["tdd", "react", "auth"]);
  });

  it("handles LLM returning no relevant skills", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[]" };
    const skills = [skill("tdd"), skill("auth")];

    const result = await scoreSkills(skills, ctx, [], 4, provider);

    expect(result).toHaveLength(0);
  });

  it("handles malformed LLM response gracefully", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "I think skills 1 and 3 are relevant" };
    const skills = [skill("tdd"), skill("auth")];

    const result = await scoreSkills(skills, ctx, ["tdd"], 4, provider);

    expect(result.map((s) => s.name)).toEqual(["tdd"]);
  });

  it("handles LLM response with surrounding text", async () => {
    const provider: ScoringProvider = {
      scoreSkills: async () =>
        "Based on the task, the most relevant skills are:\n[1, 3]\nThese cover auth and testing.",
    };
    const skills = [skill("auth"), skill("react"), skill("nextjs")];

    const result = await scoreSkills(skills, ctx, [], 2, provider);

    expect(result.map((s) => s.name)).toEqual(["auth", "nextjs"]);
  });

  it("ignores out-of-range indices", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[1, 99, 0]" };
    const skills = [skill("auth"), skill("react")];

    const result = await scoreSkills(skills, ctx, [], 4, provider);

    expect(result.map((s) => s.name)).toEqual(["auth"]);
  });

  it("respects max limit", async () => {
    const provider: ScoringProvider = { scoreSkills: async () => "[1, 2, 3]" };
    const skills = [skill("auth"), skill("react"), skill("nextjs")];

    const result = await scoreSkills(skills, ctx, [], 2, provider);

    expect(result).toHaveLength(2);
  });

  it("includes stage prompt and stage-local instructions in scoring prompt", async () => {
    const provider: ScoringProvider = {
      scoreSkills: async (prompt) => {
        expect(prompt).toContain("Prioritize the stage prompt and stage id over the overall goal");
        expect(prompt).toContain("Stage prompt:");
        expect(prompt).toContain("Implement frontend generated client and booking UI");
        return "[]";
      },
    };

    await scoreSkills(
      [skill("react"), skill("dotnet")],
      { ...ctx, stagePrompt: "Implement frontend generated client and booking UI" },
      [],
      2,
      provider,
    );
  });
});
