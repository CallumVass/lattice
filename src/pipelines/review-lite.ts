import { pipeline, stage } from "../builder/index.js";

/**
 * Strict blocking-only PR review.
 *
 * Same as `review` but without the advisory (architecture + refactor) pass.
 * Use when you only want the checklist-driven review and nothing softer.
 */
export default pipeline("review-lite", {
  description: "Strict blocking review — reviewer → judge → propose comments (user approves) → post. No advisory pass.",
  stages: [
    stage("code-review", {
      agent: "code-reviewer",
      completion: "tool_signal",
      fork: false,
      skills: { dynamic: false, pinned: ["code-review"], max: 2 },
    }),
    stage("review-judge", {
      agent: "pr-review-judge",
      completion: "tool_signal",
      fork: true,
    }),
    stage("propose-comments", {
      agent: "pr-review-composer",
      completion: "tool_signal",
      fork: true,
      pauseAfter: true,
      skills: { dynamic: false, pinned: ["pr-comments"], max: 1 },
    }),
    stage("post-comments", {
      agent: "pr-commenter",
      completion: "tool_signal",
      fork: true,
    }),
  ],
});
