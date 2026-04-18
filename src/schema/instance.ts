import { z } from "zod/v4";

const stageStatusSchema = z.enum(["pending", "running", "completed", "rejected", "skipped", "failed"]);

export type StageStatus = z.infer<typeof stageStatusSchema>;

const stageTelemetrySchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  tokensReasoning: z.number(),
  tokensCacheRead: z.number(),
  tokensCacheWrite: z.number(),
  costUSD: z.number(),
  messageCount: z.number(),
});

export type StageTelemetry = z.infer<typeof stageTelemetrySchema>;

const stageInstanceSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: stageStatusSchema,
  sessionId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  verdict: z.enum(["approve", "reject", "blocked"]).optional(),
  telemetry: stageTelemetrySchema.optional(),
});

export type StageInstance = z.infer<typeof stageInstanceSchema>;

const pipelineStatusSchema = z.enum(["running", "completed", "paused", "failed"]);

export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

const pipelineInstanceSchema = z.object({
  id: z.string(),
  pipelineName: z.string(),
  goal: z.string(),
  status: pipelineStatusSchema,
  currentStageIndex: z.number().int().min(0),
  stages: z.array(stageInstanceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** User response supplied via /lattice-retry. Consumed by the next stage's composed prompt, then cleared. */
  pendingResponse: z.string().optional(),
});

export type PipelineInstance = z.infer<typeof pipelineInstanceSchema>;
