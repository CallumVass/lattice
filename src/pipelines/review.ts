import { pipeline, stage } from "../builder/index.js";

/**
 * Standalone PR review pipeline.
 *
 * Reviews the target PR, validates findings, and posts the validated ones as
 * inline PR comments. It never rejects or halts on findings — the whole point
 * is to surface issues for a human author, not to gate an implementor loop.
 */
export default pipeline("review", {
  description: "PR code review — reviewer → judge → posts validated findings as inline PR comments",
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
    stage("post-comments", {
      agent: "pr-commenter",
      completion: "tool_signal",
      fork: true,
    }),
  ],
});
