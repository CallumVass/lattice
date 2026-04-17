import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredSkill {
  name: string;
  description: string;
  filePath: string;
  content: string;
}

const PROJECT_SKILL_DIRS = [".opencode/skills", ".claude/skills", ".agents/skills"];

const GLOBAL_SKILL_DIRS = [".config/opencode/skills", ".claude/skills", ".agents/skills"];

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  if (!raw.startsWith("---")) {
    return { body: raw };
  }

  const end = raw.indexOf("---", 3);
  if (end === -1) {
    return { body: raw };
  }

  const frontmatter = raw.slice(3, end);
  const body = raw.slice(end + 3).trim();

  let name: string | undefined;
  let description: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      name = trimmed
        .slice(5)
        .trim()
        .replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("description:")) {
      description = trimmed
        .slice(12)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  return { name, description, body };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanDir(dir: string): Promise<DiscoveredSkill[]> {
  if (!(await isDirectory(dir))) return [];

  const skills: DiscoveredSkill[] = [];
  const entries = await readdir(dir, { recursive: true });

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const fallbackName = entry.replace(/\.md$/, "").replace(/\//g, "-");

      skills.push({
        name: parsed.name ?? fallbackName,
        description: parsed.description ?? "",
        filePath,
        content: raw,
      });
    } catch {
      // skip unreadable files
    }
  }

  return skills;
}

interface ScanOptions {
  extraPaths?: string[];
  includeGlobal?: boolean;
}

export async function scanSkills(projectDir: string, options: ScanOptions = {}): Promise<DiscoveredSkill[]> {
  const { extraPaths = [], includeGlobal = true } = options;
  const dirs: string[] = [];

  // Project-level
  for (const rel of PROJECT_SKILL_DIRS) {
    dirs.push(join(projectDir, rel));
  }

  // Global
  if (includeGlobal) {
    const home = homedir();
    for (const rel of GLOBAL_SKILL_DIRS) {
      dirs.push(join(home, rel));
    }
  }

  // Extra paths from config
  for (const extra of extraPaths) {
    dirs.push(extra);
  }

  const allSkills: DiscoveredSkill[] = [];
  const seenNames = new Set<string>();

  for (const dir of dirs) {
    const skills = await scanDir(dir);
    for (const skill of skills) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      allSkills.push(skill);
    }
  }

  return allSkills;
}
