import type { PipelineDefinition } from "../schema/index.js";
import architecture from "./architecture.js";
import createJiraIssues from "./create-jira-issues.js";
import implement from "./implement.js";
import investigate from "./investigate.js";
import review from "./review.js";
import reviewLoop from "./review-loop.js";

export const builtinPipelines: PipelineDefinition[] = [
  architecture,
  review,
  reviewLoop,
  implement,
  investigate,
  createJiraIssues,
];
