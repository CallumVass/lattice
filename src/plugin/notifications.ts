// User-facing pipeline notifications.
//
// Each message has two audiences:
// - The orchestrator agent (reads it as an injected user-turn prompt). We tell
//   it to stand down so it doesn't auto-fix, auto-retry, or auto-commit.
// - The human user (sees it in their session). We give them a clean "what
//   happened" + "what to do next" block they can act on.

import type { PipelineInstance } from "../schema/index.js";

function buildUserNotification(options: { title: string; summary: string; nextSteps: string[] }): string {
  const nextStepsBlock = options.nextSteps.length
    ? ["", "### What to do next", "", ...options.nextSteps.map((s) => `- ${s}`)].join("\n")
    : "";

  return [
    "[LATTICE — STATUS UPDATE]",
    "",
    "**For the agent:** this is a status notification for the user. Do NOT act on it. Do NOT call `lattice_retry`, `lattice_abort`, `lattice_run`, or `lattice_signal`. Do NOT run git commands, tests, or any follow-up actions implied below. Wait for the user's next instruction.",
    "",
    "---",
    "",
    `## ${options.title}`,
    "",
    options.summary,
    nextStepsBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

export function pauseMessage(pipelineName: string, reason: string): string {
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" paused — review rejected`,
    summary: `The review stage flagged an issue:\n\n> ${reason}`,
    nextSteps: [
      "**Fix it manually**, then run `/lattice-retry` — lattice rewinds to the implementor with your changes in context.",
      "**Retry as-is** with `/lattice-retry` — the implementor re-runs with the rejection reason so it can try again.",
      "**Cancel** with `/lattice-abort`.",
      "**Inspect state** with `/lattice-status` before deciding.",
    ],
  });
}

export function postHookPauseMessage(pipelineName: string, stageId: string, command: string, output: string): string {
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" paused — post-hook failed`,
    summary: `Stage "${stageId}" signalled completion but its post-hook command \`${command}\` kept failing after the agent's retry attempts:\n\n\`\`\`\n${output}\n\`\`\``,
    nextSteps: [
      "**Fix it manually**, then run `/lattice-retry` to resume.",
      "**Retry as-is** with `/lattice-retry` — the stage re-runs and its post-hook fires again.",
      "**Cancel** with `/lattice-abort`.",
    ],
  });
}

export function gateMessage(pipelineName: string, reason: string, nextStageId: string | undefined): string {
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" paused — approval required`,
    summary: `${reason}\n\nRead the output above and tell the orchestrator how to proceed.`,
    nextSteps: [
      `**Approve as-is** — reply "proceed" (or similar); the orchestrator will run \`/lattice-retry\` and stage "${nextStageId ?? "next"}" will start.`,
      "**Propose changes** — reply with your changes, questions answered, or extra requirements. The orchestrator will pass them through to the next stage via `/lattice-retry`.",
      "**Cancel** with `/lattice-abort`.",
      "**Inspect state** with `/lattice-status` before deciding.",
    ],
  });
}

/**
 * Render a pause message driven by the stage's custom `pauseAfter.prompt`.
 * The pipeline author controls the body; lattice still wraps it in the
 * agent-guard envelope so the orchestrator doesn't auto-act on it.
 */
export function customGateMessage(pipelineName: string, body: string): string {
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" paused`,
    summary: body,
    nextSteps: [
      "Reply with your decision or changes; the orchestrator will pass it through via `/lattice-retry`.",
      "**Cancel** with `/lattice-abort`.",
    ],
  });
}

export function completionMessage(instance: PipelineInstance): string {
  const completedStages = instance.stages
    .filter((s) => s.status === "completed")
    .map((s) => `- **${s.id}**: ${s.summary ?? "done"}`)
    .join("\n");
  return buildUserNotification({
    title: `Pipeline "${instance.pipelineName}" complete`,
    summary: `Stages completed:\n${completedStages}`,
    nextSteps: [
      "Review the changes: `git diff` (or your editor's diff view).",
      "Run the project's test suite to verify.",
      "Commit and push when you're satisfied.",
      "Start another pipeline with `/implement`, `/review`, `/architecture`, etc.",
    ],
  });
}

export function failureMessage(pipelineName: string, stageId: string | undefined, err: unknown): string {
  const errMsg = err instanceof Error ? err.message : String(err);
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" failed`,
    summary: `Stage "${stageId ?? "unknown"}" errored:\n\n> ${errMsg}`,
    nextSteps: [
      `Rerun \`/${pipelineName}\` to start fresh once the underlying cause is fixed.`,
      "Check the opencode log at `~/.local/share/opencode/log/` for the full stack trace.",
      "`/lattice-status` can show the stored pipeline state before it's cleared.",
    ],
  });
}
