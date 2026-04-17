import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LatticeConfig, PipelineInstance } from "../schema/index.js";
import type { CompletionResult } from "./completion.js";
import { checkCompletion } from "./completion.js";
import type { FlattenedPipeline } from "./flattener.js";
import { saveInstance } from "./persistence.js";
import { composePrompt } from "./prompt.js";

export interface EngineConfig {
  projectDir: string;
  latticeConfig: LatticeConfig;
}

interface EngineResult {
  instance: PipelineInstance;
  /** Set when a stage rejected/blocked — review loop semantics. */
  pauseReason?: string;
  /** Set when a stage completed but requires user approval before advancing. */
  gateReason?: string;
}

/** What the plugin should do to run the next stage. */
interface StageAction {
  type: "inject" | "subtask";
  agent: string;
  prompt: string;
  stageId: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// --- Start ---

export async function startPipeline(
  pipeline: FlattenedPipeline,
  goal: string,
  config: EngineConfig,
): Promise<EngineResult> {
  const now = new Date().toISOString();
  const instance: PipelineInstance = {
    id: randomUUID(),
    pipelineName: pipeline.name,
    goal,
    status: "running",
    currentStageIndex: 0,
    stages: pipeline.stages.map((s) => ({
      id: s.id,
      agent: s.agent,
      status: "pending" as const,
    })),
    createdAt: now,
    updatedAt: now,
  };

  const pipelineOverride = config.latticeConfig.pipelines?.[pipeline.name];
  if (pipelineOverride?.stages) {
    for (const stageInstance of instance.stages) {
      if (pipelineOverride.stages[stageInstance.id]?.skip) {
        stageInstance.status = "skipped";
      }
    }
  }

  const firstIndex = instance.stages.findIndex((s) => s.status !== "skipped");
  if (firstIndex === -1) {
    instance.status = "completed";
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return { instance };
  }

  instance.currentStageIndex = firstIndex;
  await saveInstance(config.projectDir, instance);

  return { instance };
}

// --- Build stage action (what the plugin should execute) ---

export function buildStageAction(instance: PipelineInstance, pipeline: FlattenedPipeline): StageAction | undefined {
  const stageIndex = instance.currentStageIndex;
  const stageDef = pipeline.stages[stageIndex];
  const stageInstance = instance.stages[stageIndex];
  if (!stageDef || !stageInstance || stageInstance.status !== "pending") return undefined;

  const completedStages = instance.stages.filter((s) => s.status === "completed");
  const prompt = composePrompt({
    goal: instance.goal,
    slug: slugify(instance.goal),
    completedStages,
    currentStage: stageDef,
    pendingResponse: instance.pendingResponse,
  });

  // fork: true → inject into main session (agent switching, context carries through)
  // fork: false → subtask (cold start, visible sub-agent, adversarial independence)
  return {
    type: stageDef.fork ? "inject" : "subtask",
    agent: stageDef.agent,
    prompt,
    stageId: stageDef.id,
  };
}

/** Mark the current stage as running after the plugin has executed the action. */
export async function markStageRunning(
  instance: PipelineInstance,
  config: EngineConfig,
  childSessionId?: string,
): Promise<void> {
  const stageInstance = instance.stages[instance.currentStageIndex];
  if (!stageInstance) return;

  stageInstance.status = "running";
  stageInstance.startedAt = new Date().toISOString();
  if (childSessionId) {
    stageInstance.sessionId = childSessionId;
  }
  // Response has now been delivered via the composed prompt — clear so later stages don't re-receive it.
  instance.pendingResponse = undefined;
  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);
}

// --- Check completion (called on session.idle) ---

export async function checkStageCompletion(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
): Promise<CompletionResult> {
  const currentStage = instance.stages[instance.currentStageIndex];
  if (!currentStage || currentStage.status !== "running") {
    return { complete: false };
  }

  const stageDef = pipeline.stages[instance.currentStageIndex];
  if (!stageDef) {
    return { complete: false };
  }

  return checkCompletion(stageDef.completion, {
    plansDir: join(config.projectDir, ".lattice", "plans"),
    signalsDir: join(config.projectDir, ".lattice", "signals"),
    slug: slugify(instance.goal),
    stageId: currentStage.id,
  });
}

// --- Advance (called when stage completes) ---

export async function advancePipeline(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
  completionResult: CompletionResult,
): Promise<EngineResult> {
  const currentStage = instance.stages[instance.currentStageIndex];
  const currentStageDef = pipeline.stages[instance.currentStageIndex];
  if (!currentStage) {
    return { instance };
  }

  const shouldReject = completionResult.verdict === "reject" || completionResult.verdict === "blocked";
  currentStage.status = shouldReject ? "rejected" : "completed";
  currentStage.completedAt = new Date().toISOString();
  currentStage.summary = completionResult.summary;
  currentStage.verdict = completionResult.verdict;

  if (shouldReject) {
    instance.status = "paused";
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return {
      instance,
      pauseReason: `Stage "${currentStage.id}" ${completionResult.verdict}. ${completionResult.summary ?? ""}`.trim(),
    };
  }

  let nextIndex = instance.currentStageIndex + 1;
  while (nextIndex < instance.stages.length && instance.stages[nextIndex]?.status === "skipped") {
    nextIndex++;
  }

  if (nextIndex >= instance.stages.length) {
    instance.status = "completed";
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return { instance };
  }

  instance.currentStageIndex = nextIndex;

  // Approval gate: stage definition asked to pause after completing.
  if (currentStageDef?.pauseAfter) {
    const nextStageId = instance.stages[nextIndex]?.id ?? "next stage";
    instance.status = "paused";
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    const header = `Stage "${currentStage.id}" complete — awaiting user approval before running "${nextStageId}".`;
    const summary = currentStage.summary?.trim();
    const gateReason = summary ? `${header}\n\n### Output from "${currentStage.id}"\n\n${summary}` : header;
    return {
      instance,
      gateReason,
    };
  }

  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);

  return { instance };
}
