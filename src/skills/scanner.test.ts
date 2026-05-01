import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSkills } from "./scanner.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = join(tmpdir(), `lattice-skills-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("scanSkills", () => {
  it("returns empty for projects with no skills", async () => {
    const skills = await scanSkills(projectDir, { includeGlobal: false });
    expect(skills).toHaveLength(0);
  });

  it("discovers skills from .opencode/skills/", async () => {
    const skillsDir = join(projectDir, ".opencode", "skills", "tdd");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      join(skillsDir, "SKILL.md"),
      `---
name: tdd
description: Test-driven development patterns
---

# TDD Skill

Always write tests first.`,
    );

    const skills = await scanSkills(projectDir, { includeGlobal: false });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("tdd");
    expect(skills[0]?.description).toBe("Test-driven development patterns");
    expect(skills[0]?.content).toContain("Always write tests first");
  });

  it("uses filename as fallback name", async () => {
    const skillsDir = join(projectDir, ".opencode", "skills", "my-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "SKILL.md"), "# No frontmatter\nJust content.");

    const skills = await scanSkills(projectDir, { includeGlobal: false });
    expect(skills[0]?.name).toBe("my-skill");
    expect(skills[0]?.description).toBe("");
  });

  it("deduplicates by name, first wins", async () => {
    const dir1 = join(projectDir, ".opencode", "skills");
    const dir2 = join(projectDir, ".claude", "skills");
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    await mkdir(join(dir1, "tdd"), { recursive: true });
    await mkdir(join(dir2, "tdd"), { recursive: true });

    await writeFile(join(dir1, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: opencode version\n---\n");
    await writeFile(join(dir2, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: claude version\n---\n");

    const skills = await scanSkills(projectDir, { includeGlobal: false });
    const tdd = skills.filter((s) => s.name === "tdd");
    expect(tdd).toHaveLength(1);
    expect(tdd[0]?.description).toBe("opencode version");
  });

  it("discovers skills from extra paths", async () => {
    const extraDir = join(projectDir, "custom-skills");
    await mkdir(join(extraDir, "custom"), { recursive: true });
    await writeFile(join(extraDir, "custom", "SKILL.md"), "---\nname: custom\ndescription: Custom skill\n---\n");

    const skills = await scanSkills(projectDir, {
      extraPaths: [extraDir],
      includeGlobal: false,
    });
    expect(skills.some((s) => s.name === "custom")).toBe(true);
  });

  it("loads only SKILL.md from skill folders", async () => {
    const skillsDir = join(projectDir, ".opencode", "skills", "testing");
    await mkdir(skillsDir, { recursive: true });
    await mkdir(join(skillsDir, "references"), { recursive: true });
    await writeFile(
      join(skillsDir, "SKILL.md"),
      "---\nname: vitest\ndescription: Vitest patterns\n---\nMain skill only.",
    );
    await writeFile(join(skillsDir, "references", "details.md"), "Reference detail that should not be injected.");

    const skills = await scanSkills(projectDir, { includeGlobal: false });
    expect(skills.some((s) => s.name === "vitest")).toBe(true);
    expect(skills[0]?.content).toContain("Main skill only");
    expect(skills[0]?.content).not.toContain("Reference detail");
  });
});
