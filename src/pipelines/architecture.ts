import { pipeline, stage } from "../builder/index.js";

export default pipeline("architecture", {
  description: "Explore the codebase for architectural friction and rank candidates",
  stages: [
    stage("architecture-review", {
      agent: "architecture-reviewer",
      completion: "tool_signal",
      fork: false,
    }),
  ],
});
