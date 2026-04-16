import { z } from "zod/v4";
import { skillsConfigSchema } from "./stage.js";

const agentOverrideSchema = z.object({
  model: z.string().optional(),
  promptSuffix: z.string().optional(),
  skills: skillsConfigSchema.optional(),
});

export type AgentOverride = z.infer<typeof agentOverrideSchema>;

const stageOverrideSchema = z.object({
  skip: z.boolean().optional(),
  skills: skillsConfigSchema.optional(),
});

export type StageOverride = z.infer<typeof stageOverrideSchema>;

const pipelineOverrideSchema = z.object({
  stages: z.record(z.string(), stageOverrideSchema).optional(),
});

export type PipelineOverride = z.infer<typeof pipelineOverrideSchema>;

const learningsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  storePath: z.string().default(".lattice/learnings.jsonl"),
});

export type LearningsConfig = z.infer<typeof learningsConfigSchema>;

const latticeConfigSchema = z.object({
  agents: z.record(z.string(), agentOverrideSchema).optional(),
  pipelines: z.record(z.string(), pipelineOverrideSchema).optional(),
  skills: z
    .object({
      paths: z.array(z.string()).optional(),
      max: z.number().int().positive().optional(),
    })
    .optional(),
  learnings: learningsConfigSchema.optional(),
});

export type LatticeConfig = z.infer<typeof latticeConfigSchema>;
