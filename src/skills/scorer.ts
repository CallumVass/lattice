import type { DiscoveredSkill } from "./scanner.js";

export interface ScoringContext {
  goal: string;
  agent: string;
  stageId: string;
}

export interface ScoredSkill {
  skill: DiscoveredSkill;
  score: number;
  reason: string;
}

/** Abstraction over LLM call for testability. */
export interface ScoringProvider {
  scoreSkills(prompt: string): Promise<string>;
}

export async function scoreSkills(
  skills: DiscoveredSkill[],
  context: ScoringContext,
  pinned: string[],
  max: number,
  provider: ScoringProvider,
): Promise<DiscoveredSkill[]> {
  // Always include pinned skills
  const pinnedSkills = skills.filter((s) => pinned.includes(s.name));
  const candidates = skills.filter((s) => !pinned.includes(s.name));

  const remaining = max - pinnedSkills.length;
  if (remaining <= 0 || candidates.length === 0) {
    return pinnedSkills.slice(0, max);
  }

  // Build scoring prompt
  const skillList = candidates.map((s, i) => `${i + 1}. ${s.name}: ${s.description || "(no description)"}`).join("\n");

  const prompt = `You are a skill selector. Given a task and a list of available skills, select the most relevant ones.

Task: ${context.goal}
Agent: ${context.agent}
Stage: ${context.stageId}

Available skills:
${skillList}

Return ONLY a JSON array of skill numbers (1-indexed) ranked by relevance, most relevant first. Maximum ${remaining} skills. Only include skills that are clearly relevant to the task. If none are relevant, return an empty array.

Example: [3, 1]`;

  const response = await provider.scoreSkills(prompt);

  // Parse response — extract JSON array from LLM output
  const match = response.match(/\[[\d\s,]*\]/);
  if (!match) {
    return pinnedSkills;
  }

  let indices: number[];
  try {
    indices = JSON.parse(match[0]) as number[];
  } catch {
    return pinnedSkills;
  }

  const selected = indices
    .filter((i) => i >= 1 && i <= candidates.length)
    .slice(0, remaining)
    .map((i) => candidates[i - 1])
    .filter((s): s is DiscoveredSkill => s !== undefined);

  return [...pinnedSkills, ...selected];
}
