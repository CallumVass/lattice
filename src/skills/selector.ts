import type { SkillsConfig } from "../schema/index.js";
import type { DiscoveredSkill } from "./scanner.js";
import { type ScoringContext, type ScoringProvider, scoreSkills } from "./scorer.js";

interface SkillSelectionContext extends ScoringContext {
  skillsConfig: Partial<SkillsConfig> | undefined;
  defaultMax: number;
}

/**
 * Decide which skills to inject into an agent for a given stage.
 *
 * Hides the dynamic-score-vs-pinned-filter branching so callers don't have to
 * reach into scanner + scorer separately. Returns an empty list when the stage
 * neither pins skills nor opts into dynamic scoring.
 */
export async function selectSkills(
  allSkills: DiscoveredSkill[],
  ctx: SkillSelectionContext,
  provider: ScoringProvider,
): Promise<DiscoveredSkill[]> {
  const { skillsConfig, defaultMax, goal, agent, stageId, stagePrompt } = ctx;

  const hasPinned = (skillsConfig?.pinned?.length ?? 0) > 0;
  if (!skillsConfig?.dynamic && !hasPinned) return [];

  const pinned = skillsConfig?.pinned ?? [];
  const max = skillsConfig?.max ?? defaultMax;

  if (skillsConfig?.dynamic && allSkills.length > 0) {
    return scoreSkills(allSkills, { goal, agent, stageId, stagePrompt }, pinned, max, provider);
  }

  return allSkills.filter((s) => pinned.includes(s.name));
}
