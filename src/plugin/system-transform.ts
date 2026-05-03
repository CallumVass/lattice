import type { LatticeConfig, PipelineInstance } from "../schema/index.js";
import type { DiscoveredSkill } from "../skills/index.js";

/** Tracks which agent is active in each session. */
export class AgentTracker {
  private sessionAgents = new Map<string, string>();

  track(sessionID: string, agent: string) {
    this.sessionAgents.set(sessionID, agent);
  }

  get(sessionID: string): string | undefined {
    return this.sessionAgents.get(sessionID);
  }
}

/** Tracks which skills are selected for each session. */
export class SkillStore {
  private sessionSkills = new Map<string, DiscoveredSkill[]>();
  private stageSkills = new Map<string, DiscoveredSkill[]>();

  set(sessionID: string, skills: DiscoveredSkill[]) {
    if (skills.length === 0) this.sessionSkills.delete(sessionID);
    else this.sessionSkills.set(sessionID, skills);
  }

  get(sessionID: string): DiscoveredSkill[] {
    return this.sessionSkills.get(sessionID) ?? [];
  }

  setStage(stageKey: string, skills: DiscoveredSkill[]) {
    this.stageSkills.set(stageKey, skills);
  }

  applyStageToSession(stageKey: string | undefined, sessionID: string) {
    if (!stageKey || !this.stageSkills.has(stageKey)) return;
    this.set(sessionID, this.stageSkills.get(stageKey) ?? []);
  }
}

export function activeStageSkillKey(instance: PipelineInstance | undefined): string | undefined {
  const stage = instance?.stages[instance.currentStageIndex];
  if (!instance || !stage) return undefined;
  return stageSkillKey(instance, stage.id);
}

export function stageSkillKey(instance: PipelineInstance, stageId: string): string {
  return `${instance.id}:${stageId}`;
}

export function bindActiveStageSkillsToSession(
  skillStore: SkillStore,
  instance: PipelineInstance | undefined,
  sessionID: string | undefined,
  agent: string | undefined,
) {
  if (!sessionID || !agent || !instance || instance.status !== "running") return;
  const stage =
    instance.stages.find((candidate) => candidate.sessionId === sessionID && candidate.agent === agent) ??
    instance.stages[instance.currentStageIndex];
  if (!stage || stage.agent !== agent) return;
  skillStore.applyStageToSession(stageSkillKey(instance, stage.id), sessionID);
}

/**
 * Build the system prompt transform hook.
 * Injects agent-level promptSuffix and selected skills.
 */
export function buildSystemTransform(latticeConfig: LatticeConfig, tracker: AgentTracker, skillStore: SkillStore) {
  return async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] },
  ) => {
    if (!input.sessionID) return;

    // Inject promptSuffix
    if (latticeConfig.agents) {
      const agent = tracker.get(input.sessionID);
      if (agent) {
        const override = latticeConfig.agents[agent];
        if (override?.promptSuffix) {
          output.system.push(override.promptSuffix);
        }
      }
    }

    // Inject selected skills
    const skills = skillStore.get(input.sessionID);
    if (skills.length > 0) {
      const skillSection = skills.map((s) => `### Skill: ${s.name}\n${s.content}`).join("\n\n");
      output.system.push(`## Loaded Skills\n\n${skillSection}`);
    }
  };
}
