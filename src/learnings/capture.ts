import type { EngineConfig } from "../engine/index.js";
import type { LearningsConfig, PipelineInstance, StageInstance } from "../schema/index.js";
import { extractFromFindings } from "./extractor.js";
import { append, ensureGitignored } from "./storage.js";

interface CaptureLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const DEFAULT_STORE_PATH = ".lattice/learnings.jsonl";
const DEFAULT_AGENTS = ["code-reviewer", "planner"];
const DEFAULT_MAX_PER_AGENT = 5;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

export interface ResolvedLearningsConfig {
  enabled: boolean;
  storePath: string;
  agents: string[];
  maxPerAgent: number;
  confidenceThreshold: number;
}

export function resolveLearningsConfig(config: EngineConfig): ResolvedLearningsConfig {
  const cfg = config.latticeConfig.learnings as LearningsConfig | undefined;
  return {
    enabled: cfg?.enabled !== false,
    storePath: cfg?.storePath ?? DEFAULT_STORE_PATH,
    agents: cfg?.agents ?? DEFAULT_AGENTS,
    maxPerAgent: cfg?.maxPerAgent ?? DEFAULT_MAX_PER_AGENT,
    confidenceThreshold: cfg?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  };
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
): Promise<void> {
  if (completedStage.id !== "post-comments") return;
  if (completedStage.status !== "completed") return;
  if (completedStage.verdict === "reject" || completedStage.verdict === "blocked") return;

  const { enabled, storePath } = resolveLearningsConfig(config);
  if (!enabled) return;

  try {
    const proposeStage = instance.stages.find((s) => s.id === "propose-comments");
    const findingsText = proposeStage?.summary;
    if (!findingsText) return;

    // No explicit agent: extractor defaults blocking/advisory entries to "*"
    // so planner + reviewer + jira-drafter all see review-origin learnings.
    const entries = extractFromFindings(findingsText, {
      stageId: "propose-comments",
      goal: instance.goal,
    });

    if (entries.length === 0) return;

    await ensureGitignored(config.projectDir, storePath);
    for (const entry of entries) {
      await append(entry, { projectDir: config.projectDir, storePath });
    }

    log.info(`Captured ${entries.length} learning ${entries.length === 1 ? "entry" : "entries"}`);
  } catch (err) {
    log.warn(`Learnings capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
