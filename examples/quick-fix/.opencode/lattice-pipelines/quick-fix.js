import { pipeline, stage } from "@callumvass/lattice/builder";

export default pipeline("quick-fix", {
  description: "Plan, implement, and review a focused code fix.",
  stages: [
    stage("plan", {
      agent: "fix-planner",
      completion: "signal",
      signals: ["complete", "blocked"],
      pauseAfter: {
        prompt: "Review the plan. Reply `/lattice continue` to implement it, or `/lattice continue <edits>` with changes.\n\nPlan summary:\n{{summary}}",
      },
      prompt: "Inspect the issue and produce a concise implementation plan. Do not edit files in this stage.",
    }),
    stage("implement", {
      agent: "fix-implementor",
      completion: "signal",
      signals: ["complete", "blocked"],
      isRewindTarget: true,
      maxRewinds: 2,
      skills: { pinned: ["focused-change"] },
      prompt: "Apply the approved fix with the smallest correct change. Run the relevant checks before signalling complete.",
    }),
    stage("review", {
      agent: "fix-reviewer",
      completion: "signal",
      signals: ["pass", "fail", "blocked"],
      context: "isolated",
      prompt: "Review the implementation for correctness, regressions, and missing verification. Signal pass only when it is ready.",
    }),
  ],
});
