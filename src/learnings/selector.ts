import type { LearningEntry } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";

interface SelectLearningsContext {
  agent: string;
  goal: string;
  stageId: string;
  maxPerAgent: number;
  confidenceThreshold: number;
  now?: Date;
}

function matchesAgent(entry: LearningEntry, agent: string): boolean {
  return entry.agent === agent || entry.agent === "*";
}

function isActive(entry: LearningEntry, now: Date): boolean {
  if (entry.severity === "negative") return false;
  if (entry.expiresAt && new Date(entry.expiresAt) <= now) return false;
  return true;
}

function passesConfidence(entry: LearningEntry, threshold: number): boolean {
  return entry.confidence >= threshold;
}

function sortByConfidenceDesc(entries: LearningEntry[]): LearningEntry[] {
  return [...entries].sort((a, b) => b.confidence - a.confidence);
}

/**
 * Pick which learnings to inject into `agent`'s prompt for this stage.
 *
 * Filters by agent match, active status (not expired / not negative), and
 * confidence threshold. When the remaining candidate set is small enough
 * to fit under `maxPerAgent` we skip the LLM entirely and return them sorted
 * by confidence — this keeps costs down on the common path. Above the cap
 * we delegate to the shared scoring provider (same wire format as
 * `scoreSkills`) so the LLM ranks by goal / stage relevance.
 */
export async function selectLearningsForAgent(
  entries: LearningEntry[],
  ctx: SelectLearningsContext,
  provider: ScoringProvider,
): Promise<LearningEntry[]> {
  const now = ctx.now ?? new Date();
  const filtered = entries
    .filter((e) => matchesAgent(e, ctx.agent))
    .filter((e) => isActive(e, now))
    .filter((e) => passesConfidence(e, ctx.confidenceThreshold));

  if (filtered.length === 0) return [];
  if (filtered.length <= ctx.maxPerAgent) {
    return sortByConfidenceDesc(filtered);
  }

  const entryList = filtered
    .map(
      (e, i) =>
        `${i + 1}. [${e.severity}] (${e.category}) ${e.pattern}${
          e.description ? ` — ${e.description.replace(/\n+/g, " ")}` : ""
        }`,
    )
    .join("\n");

  const prompt = `You are ranking prior review learnings by relevance to the current task.

Task: ${ctx.goal}
Agent: ${ctx.agent}
Stage: ${ctx.stageId}

Available learnings:
${entryList}

Return ONLY a JSON array of learning numbers (1-indexed) ranked by relevance, most relevant first. Maximum ${ctx.maxPerAgent} learnings. If none are clearly relevant, return an empty array.

Example: [3, 1]`;

  const response = await provider.scoreSkills(prompt);
  const match = response.match(/\[[\d\s,]*\]/);
  if (!match) return sortByConfidenceDesc(filtered).slice(0, ctx.maxPerAgent);

  let indices: number[];
  try {
    indices = JSON.parse(match[0]) as number[];
  } catch {
    return sortByConfidenceDesc(filtered).slice(0, ctx.maxPerAgent);
  }

  const selected = indices
    .filter((i) => i >= 1 && i <= filtered.length)
    .slice(0, ctx.maxPerAgent)
    .map((i) => filtered[i - 1])
    .filter((e): e is LearningEntry => e !== undefined);

  if (selected.length === 0) return sortByConfidenceDesc(filtered).slice(0, ctx.maxPerAgent);
  return selected;
}
