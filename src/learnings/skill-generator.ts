import type { LearningEntry } from "../schema/index.js";
import type { DiscoveredSkill } from "../skills/index.js";

export const LEARNINGS_SKILL_NAME = "codebase-learnings";
const LEARNINGS_SKILL_DESCRIPTION = "Structured patterns extracted from prior review findings in this repo.";

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatEntry(entry: LearningEntry): string {
  const lines: string[] = [];
  const tag = entry.severity === "advisory" ? "advisory" : "blocking";
  lines.push(`- (learning: ${shortId(entry.id)}) [${tag}] ${entry.pattern}`);
  if (entry.description) {
    for (const line of entry.description.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) lines.push(`  ${trimmed}`);
    }
  }
  return lines.join("\n");
}

function groupByCategory(entries: LearningEntry[]): Map<string, LearningEntry[]> {
  const groups = new Map<string, LearningEntry[]>();
  for (const entry of entries) {
    const key = entry.category || "general";
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

/**
 * Render selected learning entries as a synthetic skill markdown block so the
 * existing system-transform hook can inject them alongside normal skills.
 * Entries are grouped by category and each line is prefixed with its short
 * id so the reviewer can cite matches back.
 */
export function renderLearningsAsSkill(entries: LearningEntry[]): DiscoveredSkill | undefined {
  if (entries.length === 0) return undefined;

  const groups = groupByCategory(entries);
  const sections: string[] = [];
  sections.push("Patterns extracted from prior review findings on this repo.");
  sections.push("");
  sections.push(
    "If a new finding recurs one of these patterns, cite it as `(learning: <id>)` in the finding body. Do NOT suppress a finding just because no matching learning exists here.",
  );

  for (const [category, items] of groups) {
    sections.push("");
    sections.push(`## ${category}`);
    sections.push("");
    for (const entry of items) {
      sections.push(formatEntry(entry));
    }
  }

  return {
    name: LEARNINGS_SKILL_NAME,
    description: LEARNINGS_SKILL_DESCRIPTION,
    filePath: "<learnings>",
    content: sections.join("\n"),
  };
}
