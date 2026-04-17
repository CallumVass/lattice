import { pipeline, stage } from "../builder/index.js";

/**
 * Standalone PR review pipeline.
 *
 * Runs a checklist-driven review, validates the findings, layers on an
 * advisory architecture + refactor pass, then composes the proposed PR
 * comments and pauses for the user to approve before posting.
 *
 * For a strict blocking-only review (no advisory pass), use `review-lite`.
 */
export default pipeline("review", {
  description:
    "PR code review — reviewer → judge → advisory (architecture + refactor) → propose comments (user approves) → post",
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
    stage("advisory-review", {
      agent: "architecture-reviewer",
      completion: "tool_signal",
      fork: true,
      prompt: [
        "Run an **advisory** pass over the same diff the reviewer/judge just worked with. This is additive — it does not block and does not duplicate what the judge already flagged.",
        "",
        "## Scope",
        "1. Re-resolve the diff the same way the code-reviewer did (PR number/URL → `gh pr diff`; branch → `git diff <base>...<branch>`; otherwise `git diff $(git merge-base HEAD origin/main)...HEAD`).",
        "2. Explore the existing codebase enough to ground your judgement in the current patterns — don't critique in a vacuum.",
        "",
        "## What to report",
        "",
        "### Architecture Delta",
        "Does the diff introduce or worsen architectural friction relative to what's already in the codebase? Look for:",
        "- Duplicating an abstraction that already exists",
        "- Missing reuse of existing shared utilities or patterns",
        "- Cross-feature imports where a public entry point already exists",
        "- Flat-root sprawl or junk-drawer growth",
        "- Touched files trending toward god modules",
        "- Concerns mixed more tightly than existing conventions",
        "",
        "Only report concerns **introduced or clearly worsened** by this diff.",
        "",
        "### Refactor Opportunities",
        "Max 3. Only clear wins where the diff could better align with existing patterns. For each, quote the code and state the concrete payoff.",
        "",
        "## Output format",
        "Use the same FINDINGS shape as the reviewer, but with `severity: advisory`. Include `File: path:line` wherever possible so the next stage can attach inline comments. If a concern is purely structural and has no single line, omit the line and say so in the issue text — the poster will fall back to a general PR comment.",
        "",
        "If you have nothing above the bar in either section, output exactly `NO_FINDINGS`.",
        "",
        "Signal complete with your full advisory FINDINGS report (or `NO_FINDINGS`) in `reason`.",
      ].join("\n"),
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
