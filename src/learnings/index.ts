// Learnings facade — single entry point for the rest of the codebase.
// Captures structured findings from review pipelines for later injection.

export { captureLearningsFromReview, resolveLearningsConfig } from "./capture.js";
export { count } from "./storage.js";
