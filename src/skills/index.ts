// Skill facade — the single entry point plugin code uses for skill discovery,
// scoring, and selection. Consumers outside the package should not reach past
// this file into submodules.

export { createOpencodeScoringProvider } from "./opencode-scoring.js";
export { type DiscoveredSkill, scanSkills } from "./scanner.js";
export type { ScoringContext, ScoringProvider } from "./scorer.js";
export { selectSkills } from "./selector.js";
