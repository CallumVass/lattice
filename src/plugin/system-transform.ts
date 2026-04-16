import type { LatticeConfig } from "../schema/index.js";
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

  set(sessionID: string, skills: DiscoveredSkill[]) {
    this.sessionSkills.set(sessionID, skills);
  }

  get(sessionID: string): DiscoveredSkill[] {
    return this.sessionSkills.get(sessionID) ?? [];
  }
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
