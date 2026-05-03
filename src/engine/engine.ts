import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LatticeConfig, PipelineInstance, PipelinePause, StageDefinition } from "../schema/index.js";
import { stageDefinitionSchema } from "../schema/index.js";
import type { CompletionResult } from "./completion.js";
import { checkCompletion } from "./completion.js";
import type { FlattenedPipeline } from "./flattener.js";
import { saveInstance } from "./persistence.js";
import { composePrompt } from "./prompt.js";

export interface EngineConfig {
  projectDir: string;
  latticeConfig: LatticeConfig;
}

export function effectivePipeline(instance: PipelineInstance, pipeline: FlattenedPipeline): FlattenedPipeline {
  return instance.runtimeStages ? { ...pipeline, stages: instance.runtimeStages } : pipeline;
}

export async function expandCurrentStageIfNeeded(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
): Promise<FlattenedPipeline> {
  const effective = effectivePipeline(instance, pipeline);
  return expandStageAt(instance, effective, config, instance.currentStageIndex);
}

export async function expandRunnableStagesIfNeeded(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
): Promise<FlattenedPipeline> {
  let effective = effectivePipeline(instance, pipeline);

  while (true) {
    const expandableIndex = currentRangeIndices(effective, instance.currentStageIndex).find((index) => {
      const stageDef = effective.stages[index];
      const stageInst = instance.stages[index];
      return !!stageDef?.expand && stageInst?.status === "pending";
    });

    if (expandableIndex === undefined) return effective;
    effective = await expandStageAt(instance, effective, config, expandableIndex);
  }
}

async function expandStageAt(
  instance: PipelineInstance,
  effective: FlattenedPipeline,
  config: EngineConfig,
  stageIndex: number,
): Promise<FlattenedPipeline> {
  const stageDef = effective.stages[stageIndex];
  const stageInst = instance.stages[stageIndex];
  if (!stageDef?.expand || !stageInst || stageInst.status !== "pending") return effective;

  const expanded = (await renderExpandedStages(stageDef, config.projectDir)).map((stage) => ({
    ...stage,
    ...(stageDef.parallelGroup && !stage.parallelGroup && { parallelGroup: stageDef.parallelGroup }),
  }));
  if (stageDef.parallelGroup) {
    for (const stage of expanded) {
      if (stage.context !== "isolated") {
        throw new Error(`Dynamic parallel stage "${stage.id}" must use isolated context`);
      }
      if (stage.pauseAfter !== false) {
        throw new Error(`Dynamic parallel stage "${stage.id}" cannot use pauseAfter`);
      }
    }
  }
  const nextStages = [...effective.stages];
  nextStages.splice(stageIndex, 1, ...expanded);

  const nextInstances = [...instance.stages];
  nextInstances.splice(
    stageIndex,
    1,
    ...expanded.map((stage) => ({ id: stage.id, agent: stage.agent, status: "pending" as const })),
  );

  instance.stages = nextInstances;
  instance.runtimeStages = nextStages;
  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);

  return { ...effective, stages: nextStages };
}

async function renderExpandedStages(stageDef: StageDefinition, projectDir: string): Promise<StageDefinition[]> {
  const expansion = stageDef.expand;
  if (!expansion) return [stageDef];

  if (expansion.from.startsWith("/") || expansion.from.split(/[\\/]/).includes("..")) {
    throw new Error(`Dynamic stage "${stageDef.id}" has unsafe manifest path: ${expansion.from}`);
  }

  const manifest = JSON.parse(await readFile(join(projectDir, expansion.from), "utf8")) as unknown;
  const items = readArrayPath(manifest, expansion.arrayPath);
  if (items.length > expansion.maxItems) {
    throw new Error(
      `Dynamic stage "${stageDef.id}" manifest has ${items.length} items, exceeding maxItems ${expansion.maxItems}`,
    );
  }

  const seen = new Set<string>();
  return items.map((item, position) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Dynamic stage "${stageDef.id}" item ${position + 1} is not an object`);
    }
    const rendered = renderTemplateValue(expansion.template, {
      ...(item as Record<string, unknown>),
      manifest,
      position: position + 1,
    });
    const parsed = stageDefinitionSchema.parse(rendered);
    const safeId = sanitizeStageId(parsed.id);
    if (seen.has(safeId)) throw new Error(`Dynamic stage "${stageDef.id}" produced duplicate stage id: ${safeId}`);
    seen.add(safeId);
    return { ...parsed, id: safeId, expand: undefined };
  });
}

function readArrayPath(value: unknown, path: string): unknown[] {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") throw new Error(`Manifest path "${path}" does not exist`);
    current = (current as Record<string, unknown>)[part];
  }
  if (!Array.isArray(current)) throw new Error(`Manifest path "${path}" is not an array`);
  return current;
}

function renderTemplateValue(value: unknown, item: Record<string, unknown>): unknown {
  if (typeof value === "string")
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
      formatTemplateValue(readTemplatePath(item, key)),
    );
  if (Array.isArray(value)) return value.map((entry) => renderTemplateValue(entry, item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderTemplateValue(entry, item)]));
}

function readTemplatePath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) return value.map((entry) => `- ${entry}`).join("\n");
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function sanitizeStageId(id: string): string {
  const sanitized = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error(`Dynamic stage produced an empty sanitized id from "${id}"`);
  return sanitized;
}

interface EngineResult {
  instance: PipelineInstance;
  /** Set when the pipeline transitions to paused. */
  pause?: PipelinePause;
  /** Non-fatal diagnostics the plugin should log — e.g. an agent signalled outside its declared signals. */
  diagnostics?: string[];
}

/** What the plugin should do to run a stage. */
interface StageAction {
  type: "inject" | "subtask";
  agent: string;
  prompt: string;
  stageId: string;
  stageIndex: number;
}

interface StageRange {
  start: number;
  end: number;
}

function sameParallelGroup(a: StageDefinition["parallelGroup"], b: StageDefinition["parallelGroup"]): boolean {
  return !!a && !!b && a.id === b.id;
}

function currentRange(pipeline: FlattenedPipeline, stageIndex: number): StageRange {
  const stage = pipeline.stages[stageIndex];
  const group = stage?.parallelGroup;
  if (!stage || !group) return { start: stageIndex, end: stageIndex + 1 };

  let start = stageIndex;
  while (start > 0 && sameParallelGroup(pipeline.stages[start - 1]?.parallelGroup, group)) start--;

  let end = stageIndex + 1;
  while (end < pipeline.stages.length && sameParallelGroup(pipeline.stages[end]?.parallelGroup, group)) end++;

  return { start, end };
}

function currentRangeIndices(pipeline: FlattenedPipeline, stageIndex: number): number[] {
  const range = currentRange(pipeline, stageIndex);
  const indices: number[] = [];
  for (let index = range.start; index < range.end; index++) indices.push(index);
  return indices;
}

function nextRunnableIndex(instance: PipelineInstance, start: number): number {
  let index = start;
  while (index < instance.stages.length && instance.stages[index]?.status === "skipped") index++;
  return index;
}

function runnableStageIndices(instance: PipelineInstance, pipeline: FlattenedPipeline): number[] {
  if (instance.status !== "running") return [];

  const currentStage = instance.stages[instance.currentStageIndex];
  const currentStageDef = pipeline.stages[instance.currentStageIndex];
  if (!currentStage || !currentStageDef) return [];

  const indices = currentRangeIndices(pipeline, instance.currentStageIndex);
  const group = currentStageDef.parallelGroup;
  if (!group) return currentStage.status === "pending" ? [instance.currentStageIndex] : [];

  const activeCount = indices.filter((index) => {
    const status = instance.stages[index]?.status;
    return status === "dispatching" || status === "running";
  }).length;
  const limit = group.maxConcurrency ?? indices.length;
  const available = Math.max(0, limit - activeCount);
  if (available === 0) return [];

  return indices.filter((index) => instance.stages[index]?.status === "pending").slice(0, available);
}

function completedStagesForStage(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  stageIndex: number,
): PipelineInstance["stages"] {
  const stageDef = pipeline.stages[stageIndex];
  if (!stageDef?.parallelGroup) return instance.stages.filter((s) => s.status === "completed");

  const range = currentRange(pipeline, stageIndex);
  return instance.stages.slice(0, range.start).filter((s) => s.status === "completed");
}

// --- Start ---

export async function startPipeline(
  pipeline: FlattenedPipeline,
  goal: string,
  config: EngineConfig,
  parentSessionId?: string,
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
    ...(parentSessionId && { parentSessionId }),
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

export function buildStageActions(instance: PipelineInstance, pipeline: FlattenedPipeline): StageAction[] {
  return runnableStageIndices(instance, pipeline)
    .map((stageIndex) => buildStageActionAt(instance, pipeline, stageIndex))
    .filter((action): action is StageAction => action !== undefined);
}

export function buildStageAction(instance: PipelineInstance, pipeline: FlattenedPipeline): StageAction | undefined {
  return buildStageActions(instance, pipeline)[0];
}

function buildStageActionAt(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  stageIndex: number,
): StageAction | undefined {
  const stageDef = pipeline.stages[stageIndex];
  const stageInstance = instance.stages[stageIndex];
  if (!stageDef || !stageInstance || stageInstance.status !== "pending") return undefined;

  const completedStages = completedStagesForStage(instance, pipeline, stageIndex);
  const prompt = composePrompt({
    goal: instance.goal,
    completedStages,
    currentStage: stageDef,
    resumeContext: instance.resumeContext,
  });

  // shared → inject into main session (agent switching, context carries through)
  // isolated → subtask (cold start, visible sub-agent, adversarial independence)
  return {
    type: stageDef.context === "shared" ? "inject" : "subtask",
    agent: stageDef.agent,
    prompt,
    stageId: stageDef.id,
    stageIndex,
  };
}

/** Persist the dispatch intent before calling out to opencode. */
export async function markStageDispatching(
  instance: PipelineInstance,
  config: EngineConfig,
  parentSessionId?: string,
): Promise<string | undefined> {
  return markStageDispatchingAt(instance, config, instance.currentStageIndex, parentSessionId);
}

export async function markStageDispatchingAt(
  instance: PipelineInstance,
  config: EngineConfig,
  stageIndex: number,
  parentSessionId?: string,
): Promise<string | undefined> {
  const stageInstance = instance.stages[stageIndex];
  if (!stageInstance || stageInstance.status !== "pending") return undefined;

  const now = new Date().toISOString();
  const dispatchId = randomUUID();
  stageInstance.status = "dispatching";
  stageInstance.dispatchId = dispatchId;
  stageInstance.dispatchedAt = now;
  if (parentSessionId) instance.parentSessionId = parentSessionId;
  instance.updatedAt = now;
  await saveInstance(config.projectDir, instance);
  return dispatchId;
}

/** Mark the current stage as running after the plugin has executed the action. */
export async function markStageRunning(
  instance: PipelineInstance,
  config: EngineConfig,
  childSessionId?: string,
): Promise<void> {
  return markStageRunningAt(instance, config, instance.currentStageIndex, childSessionId);
}

/** Mark a stage as running after the plugin has executed the action. */
export async function markStageRunningAt(
  instance: PipelineInstance,
  config: EngineConfig,
  stageIndex: number,
  childSessionId?: string,
): Promise<void> {
  const stageInstance = instance.stages[stageIndex];
  if (!stageInstance) return;
  if (
    stageInstance.status === "completed" ||
    stageInstance.status === "rejected" ||
    stageInstance.status === "skipped"
  ) {
    return;
  }
  if (stageInstance.status === "failed") return;

  stageInstance.status = "running";
  stageInstance.startedAt = stageInstance.startedAt ?? new Date().toISOString();
  if (childSessionId) {
    stageInstance.sessionId = childSessionId;
  }
  // Response has now been delivered via the composed prompt — clear so later stages don't re-receive it.
  instance.resumeContext = undefined;
  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);
}

// --- Check completion (called on session.idle) ---

export async function checkStageCompletion(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
): Promise<CompletionResult> {
  return checkStageCompletionAt(instance, pipeline, config, instance.currentStageIndex);
}

export async function checkStageCompletionAt(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
  stageIndex: number,
): Promise<CompletionResult> {
  const currentStage = instance.stages[stageIndex];
  if (!currentStage || currentStage.status !== "running") {
    return { complete: false };
  }

  const stageDef = pipeline.stages[stageIndex];
  if (!stageDef) {
    return { complete: false };
  }

  return checkCompletion(stageDef.completion, {
    signalsDir: join(config.projectDir, ".lattice", "signals", instance.id),
    legacySignalsDir: join(config.projectDir, ".lattice", "signals"),
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
  return advancePipelineAt(instance, pipeline, config, completionResult, instance.currentStageIndex);
}

export async function advancePipelineAt(
  instance: PipelineInstance,
  pipeline: FlattenedPipeline,
  config: EngineConfig,
  completionResult: CompletionResult,
  stageIndex: number,
): Promise<EngineResult> {
  const currentStage = instance.stages[stageIndex];
  const currentStageDef = pipeline.stages[stageIndex];
  if (!currentStage) {
    return { instance };
  }

  const diagnostics: string[] = [];
  if (currentStageDef?.completion === "signal" && completionResult.signal && currentStageDef.signals) {
    if (!currentStageDef.signals.includes(completionResult.signal)) {
      diagnostics.push(
        `Stage "${currentStage.id}" signalled "${completionResult.signal}" but its declared signals are: ${currentStageDef.signals.join(", ")}. Proceeding with the signal as given.`,
      );
    }
  }

  const shouldReject = completionResult.verdict === "fail" || completionResult.verdict === "blocked";
  currentStage.status = shouldReject ? "rejected" : "completed";
  currentStage.completedAt = new Date().toISOString();
  currentStage.summary = completionResult.summary;
  currentStage.verdict = completionResult.verdict;

  if (shouldReject) {
    const pause: PipelinePause = {
      kind: completionResult.verdict === "blocked" ? "blocked" : "rejection",
      stageId: currentStage.id,
      reason: `Stage "${currentStage.id}" ${completionResult.verdict}. ${completionResult.summary ?? ""}`.trim(),
    };
    instance.status = "paused";
    instance.pause = pause;
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return {
      instance,
      pause,
      ...(diagnostics.length > 0 && { diagnostics }),
    };
  }

  const range = currentStageDef?.parallelGroup
    ? currentRange(pipeline, stageIndex)
    : { start: stageIndex, end: stageIndex + 1 };
  const groupComplete = currentStageDef?.parallelGroup
    ? currentRangeIndices(pipeline, stageIndex).every((index) => {
        const status = instance.stages[index]?.status;
        return status === "completed" || status === "skipped";
      })
    : true;

  if (!groupComplete) {
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return { instance, ...(diagnostics.length > 0 && { diagnostics }) };
  }

  const nextIndex = nextRunnableIndex(instance, range.end);

  if (nextIndex >= instance.stages.length) {
    instance.status = "completed";
    instance.pause = undefined;
    instance.updatedAt = new Date().toISOString();
    await saveInstance(config.projectDir, instance);
    return { instance, ...(diagnostics.length > 0 && { diagnostics }) };
  }

  instance.currentStageIndex = nextIndex;

  // Checkpoint gate: stage definition asked to pause after completing.
  if (currentStageDef?.pauseAfter) {
    const nextStageId = instance.stages[nextIndex]?.id ?? "next stage";
    instance.status = "paused";
    instance.updatedAt = new Date().toISOString();

    const pauseConfig = currentStageDef.pauseAfter;
    const isObjectConfig = typeof pauseConfig === "object";

    const customPromptTemplate = isObjectConfig ? pauseConfig.prompt : undefined;
    const customPrompt = customPromptTemplate
      ? renderPausePrompt(customPromptTemplate, currentStage.summary)
      : undefined;

    const header = `Stage "${currentStage.id}" complete. Waiting for user approval before running "${nextStageId}".`;
    const summary = currentStage.summary?.trim();
    const reason = summary ? `${header}\n\nOutput from "${currentStage.id}":\n${summary}` : header;
    const pause: PipelinePause = {
      kind: "checkpoint",
      stageId: currentStage.id,
      nextStageId,
      reason,
      ...(customPrompt && { prompt: customPrompt }),
    };
    instance.pause = pause;

    await saveInstance(config.projectDir, instance);

    return {
      instance,
      pause,
      ...(diagnostics.length > 0 && { diagnostics }),
    };
  }

  instance.pause = undefined;
  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);

  return { instance, ...(diagnostics.length > 0 && { diagnostics }) };
}

function renderPausePrompt(template: string, summary: string | undefined): string {
  const value = summary ?? "";
  return template.replace(/\{\{\s*summary\s*\}\}/g, value).replace(/\{\{\s*reason\s*\}\}/g, value);
}
