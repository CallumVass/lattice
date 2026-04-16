import { z } from "zod/v4";

export const learningSeveritySchema = z.enum(["blocking", "advisory", "negative"]);

export type LearningSeverity = z.infer<typeof learningSeveritySchema>;

const learningSourceSchema = z.object({
  pr: z.string().optional(),
  stageId: z.string(),
  date: z.string().datetime(),
});

export const learningEntrySchema = z.object({
  id: z.string().uuid(),
  agent: z.string(),
  pattern: z.string(),
  description: z.string().optional(),
  category: z.string(),
  severity: learningSeveritySchema,
  source: learningSourceSchema,
  confidence: z.number().min(0).max(1),
  usageCount: z.number().int().min(0).default(0),
  feedbackScore: z.number().min(-1).max(1).default(0),
  reinforcementCount: z.number().int().min(0).default(0),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type LearningEntry = z.infer<typeof learningEntrySchema>;
