import { pipeline, stage } from "../builder/index.js";

/**
 * Internal review pipeline used inside `/implement`.
 *
 * Unlike the standalone `/review` pipeline, this one pauses on validated
 * findings so the implementor can be rewound and the issues fixed. It is
 * not intended to be invoked directly — use `/review` for ad-hoc PR review.
 */
export default pipeline("review-loop", {
  description: "Internal review loop used by /implement — rejects pause the pipeline for implementor retry",
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
