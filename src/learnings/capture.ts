import type { EngineConfig } from "../engine/index.js";
import type { LearningEntry, LearningsConfig, PipelineInstance, StageInstance } from "../schema/index.js";
import { findReinforcementTarget } from "./compaction.js";
import { reinforce } from "./decay.js";
import { extractFromFindings } from "./extractor.js";
import { append, ensureGitignored, readAll, writeAll } from "./storage.js";

interface CaptureLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const DEFAULT_STORE_PATH = ".lattice/learnings.jsonl";
const DEFAULT_AGENTS = ["code-reviewer", "planner", "jira-planner"];
const DEFAULT_MAX_PER_AGENT = 5;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_DECAY_RATE = 0.05;
const DEFAULT_REINFORCEMENT_BOOST = 0.15;
const DEFAULT_INVALID_PENALTY = 0.4;
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const NEGATIVE_LEARNING_CONFIDENCE = 0.7;

export interface ResolvedLearningsConfig {
  enabled: boolean;
  storePath: string;
  agents: string[];
  maxPerAgent: number;
  confidenceThreshold: number;
  decayRate: number;
  reinforcementBoost: number;
  invalidPenalty: number;
  similarityThreshold: number;
}

export function resolveLearningsConfig(config: EngineConfig): ResolvedLearningsConfig {
  const cfg = config.latticeConfig.learnings as LearningsConfig | undefined;
  return {
    enabled: cfg?.enabled !== false,
    storePath: cfg?.storePath ?? DEFAULT_STORE_PATH,
    agents: cfg?.agents ?? DEFAULT_AGENTS,
    maxPerAgent: cfg?.maxPerAgent ?? DEFAULT_MAX_PER_AGENT,
    confidenceThreshold: cfg?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    decayRate: cfg?.decayRate ?? DEFAULT_DECAY_RATE,
    reinforcementBoost: cfg?.reinforcementBoost ?? DEFAULT_REINFORCEMENT_BOOST,
    invalidPenalty: cfg?.invalidPenalty ?? DEFAULT_INVALID_PENALTY,
    similarityThreshold: cfg?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
  };
}

interface CaptureOptions {
  /**
   * 1-indexed finding numbers the user killed during the approval gate. The
   * matching extracted entries become `severity: "negative"` learnings
   * scoped to `code-reviewer` — they teach the reviewer what NOT to flag.
   */
  killIndices?: number[];
  /**
   * Composer's pre-kill summary. The approval-gate retry mutates the stage's
   * summary in-place so the poster only sees survivors; capture still wants
   * the full ordered set to mint negatives for the kills.
   */
  originalSummary?: string;
  now?: () => Date;
}

interface PersistResult {
  positive: number;
  negative: number;
  reinforced: number;
}

async function persistEntries(
  extracted: LearningEntry[],
  killIndices: number[] | undefined,
  resolved: ResolvedLearningsConfig,
  projectDir: string,
  now: () => Date,
): Promise<PersistResult> {
  const storage = { projectDir, storePath: resolved.storePath };
  const kills = new Set(killIndices ?? []);
  const survivors: LearningEntry[] = [];
  const negatives: LearningEntry[] = [];

  extracted.forEach((entry, i) => {
    const oneIndexed = i + 1;
    if (kills.has(oneIndexed)) {
      negatives.push({
        ...entry,
        agent: "code-reviewer",
        severity: "negative",
        confidence: NEGATIVE_LEARNING_CONFIDENCE,
      });
    } else {
      survivors.push(entry);
    }
  });

  if (survivors.length === 0 && negatives.length === 0) {
    return { positive: 0, negative: 0, reinforced: 0 };
  }

  await ensureGitignored(projectDir, resolved.storePath);

  let existing = await readAll(storage);
  let reinforced = 0;
  let added = 0;

  for (const candidate of survivors) {
    const target = findReinforcementTarget(existing, candidate, {
      similarityThreshold: resolved.similarityThreshold,
    });
    if (target) {
      const updated = reinforce(target, now(), resolved.reinforcementBoost);
      existing = existing.map((e) => (e.id === target.id ? updated : e));
      reinforced += 1;
    } else {
      existing.push(candidate);
      added += 1;
    }
  }

  if (reinforced > 0) {
    await writeAll(existing, storage);
  } else if (added > 0) {
    for (const candidate of survivors) {
      await append(candidate, storage);
    }
  }

  for (const negative of negatives) {
    await append(negative, storage);
  }

  return { positive: added, negative: negatives.length, reinforced };
}

/**
 * After a `post-comments` stage completes successfully, harvest the FINDINGS
 * the composer prepared (the previous `propose-comments` stage's summary)
 * and persist one learning entry per finding. Best-effort — failures here
 * never affect the pipeline run or the PR comments that were already posted.
 */
export async function captureLearningsFromReview(
  instance: PipelineInstance,
  completedStage: StageInstance,
  config: EngineConfig,
  log: CaptureLogger,
  options: CaptureOptions = {},
): Promise<void> {
  if (completedStage.id !== "post-comments") return;
  if (completedStage.status !== "completed") return;
  if (completedStage.verdict === "reject" || completedStage.verdict === "blocked") return;

  const resolved = resolveLearningsConfig(config);
  if (!resolved.enabled) return;

  try {
    const proposeStage = instance.stages.find((s) => s.id === "propose-comments");
    const findingsText = options.originalSummary ?? proposeStage?.summary;
    if (!findingsText) return;

    // No explicit agent: extractor defaults blocking/advisory entries to "*"
    // so planner + reviewer + jira-drafter all see review-origin learnings.
    const entries = extractFromFindings(findingsText, {
      stageId: "propose-comments",
      goal: instance.goal,
      now: options.now,
    });

    if (entries.length === 0) return;

    const now = options.now ?? (() => new Date());
    const result = await persistEntries(entries, options.killIndices, resolved, config.projectDir, now);

    const total = result.positive + result.negative + result.reinforced;
    if (total === 0) return;
    const parts = [
      `${result.positive} new`,
      result.reinforced > 0 ? `${result.reinforced} reinforced` : undefined,
      result.negative > 0 ? `${result.negative} negative` : undefined,
    ].filter((p): p is string => Boolean(p));
    log.info(`Captured learnings: ${parts.join(", ")}`);
  } catch (err) {
    log.warn(`Learnings capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
