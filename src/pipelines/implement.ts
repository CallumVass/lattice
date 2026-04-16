import { pipeline, ref, stage } from "../builder/index.js";

export default pipeline("implement", {
  description: "Plan, architecture review, TDD implement, refactor, and review",
  stages: [
    stage("plan", {
      agent: "planner",
      completion: "plan_created",
      fork: false,
      skills: { dynamic: true, pinned: ["opensrc"], max: 4 },
    }),
    stage("arch-review", {
      agent: "architecture-reviewer",
      completion: "idle",
      fork: true,
      pauseAfter: true,
    }),
    stage("implement", {
      agent: "implementor",
      completion: "plan_complete",
      fork: true,
      skills: { dynamic: true, pinned: ["tdd", "opensrc"], max: 4 },
    }),
    stage("refactor", {
      agent: "refactorer",
      completion: "idle",
      fork: true,
    }),
    ref("review-loop"),
  ],
});
