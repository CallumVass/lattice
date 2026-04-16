// Skill facade — phase 2 will add selectSkills() here. For now, re-export
// the provider/data types so external packages can implement a custom
// ScoringProvider without reaching into submodules.

export type { DiscoveredSkill } from "./scanner.js";
export type { ScoringContext, ScoringProvider } from "./scorer.js";
