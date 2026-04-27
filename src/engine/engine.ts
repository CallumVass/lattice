import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LatticeConfig, PipelineInstance, StageDefinition } from "../schema/index.js";
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
  const stageDef = effective.stages[instance.currentStageIndex];
  const stageInst = instance.stages[instance.currentStageIndex];
  if (!stageDef?.expand || !stageInst || stageInst.status !== "pending") return effective;

  const expanded = await renderExpandedStages(stageDef, config.projectDir);
  const nextStages = [...effective.stages];
  nextStages.splice(instance.currentStageIndex, 1, ...expanded);

  const nextInstances = [...instance.stages];
  nextInstances.splice(
    instance.currentStageIndex,
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
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => String(item[key] ?? ""));
  if (Array.isArray(value)) return value.map((entry) => renderTemplateValue(entry, item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderTemplateValue(entry, item)]));
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
  /** Set when a stage rejected/blocked — review loop semantics. */
  pauseReason?: string;
  /** Set when a stage completed but requires user approval before advancing. */
  gateReason?: string;
  /** Rendered custom pause body from the completed stage's `pauseAfter.prompt`, if provided. */
  customGatePrompt?: string;
  /** True when the gate was `pauseAfter: { hardGate: true }` — requires a user-typed /lattice-retry to release. */
  hardGate?: boolean;
  /** Non-fatal diagnostics the plugin should log — e.g. an agent signalled outside its declared signals. */
  diagnostics?: string[];
}

/** What the plugin should do to run the next stage. */
interface StageAction {
  type: "inject" | "subtask";
  agent: string;
  prompt: string;
  stageId: string;
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
    signalsDir: join(config.projectDir, ".lattice", "signals"),
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

  const diagnostics: string[] = [];
  if (currentStageDef?.completion === "tool_signal" && completionResult.signal && currentStageDef.signals) {
    if (!currentStageDef.signals.includes(completionResult.signal)) {
      diagnostics.push(
        `Stage "${currentStage.id}" signalled "${completionResult.signal}" but its declared signals are: ${currentStageDef.signals.join(", ")}. Proceeding with the signal as given.`,
      );
    }
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
      ...(diagnostics.length > 0 && { diagnostics }),
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
    return { instance, ...(diagnostics.length > 0 && { diagnostics }) };
  }

  instance.currentStageIndex = nextIndex;

  // Approval gate: stage definition asked to pause after completing.
  if (currentStageDef?.pauseAfter) {
    const nextStageId = instance.stages[nextIndex]?.id ?? "next stage";
    instance.status = "paused";
    instance.updatedAt = new Date().toISOString();

    const pauseConfig = currentStageDef.pauseAfter;
    const isObjectConfig = typeof pauseConfig === "object";
    const hardGate = isObjectConfig && pauseConfig.hardGate === true;
    instance.hardGated = hardGate ? true : undefined;

    await saveInstance(config.projectDir, instance);

    const customPromptTemplate = isObjectConfig ? pauseConfig.prompt : undefined;
    const customPrompt = customPromptTemplate
      ? renderPausePrompt(customPromptTemplate, currentStage.summary)
      : undefined;

    const header = `Stage "${currentStage.id}" complete — awaiting user approval before running "${nextStageId}".`;
    const summary = currentStage.summary?.trim();
    const gateReason = summary ? `${header}\n\n### Output from "${currentStage.id}"\n\n${summary}` : header;

    return {
      instance,
      gateReason,
      ...(customPrompt && { customGatePrompt: customPrompt }),
      ...(hardGate && { hardGate: true }),
      ...(diagnostics.length > 0 && { diagnostics }),
    };
  }

  instance.updatedAt = new Date().toISOString();
  await saveInstance(config.projectDir, instance);

  return { instance, ...(diagnostics.length > 0 && { diagnostics }) };
}

function renderPausePrompt(template: string, summary: string | undefined): string {
  const value = summary ?? "";
  return template.replace(/\{\{\s*summary\s*\}\}/g, value).replace(/\{\{\s*reason\s*\}\}/g, value);
}
