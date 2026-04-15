import { pipeline, stage } from "../builder/index.js";

export default pipeline("review", {
  description: "Structured code review with adversarial validation",
  stages: [
    stage("code-review", {
      agent: "code-reviewer",
      completion: "tool_signal",
      fork: false,
      skills: { dynamic: false, pinned: ["code-review"], max: 2 },
    }),
    stage("review-judge", {
      agent: "review-judge",
      completion: "tool_signal",
      fork: true,
    }),
  ],
});
