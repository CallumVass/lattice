// Learnings facade — single entry point for the rest of the codebase.
// Captures structured findings from review pipelines and injects them back
// into future reviewer prompts.

export { captureLearningsFromReview, type ResolvedLearningsConfig, resolveLearningsConfig } from "./capture.js";
export { recordRun, summarizeFindings, trailingAverage } from "./metrics.js";
export { selectLearningsForAgent } from "./selector.js";
export { renderLearningsAsSkill } from "./skill-generator.js";
export { count, readAll as readAllLearnings } from "./storage.js";
