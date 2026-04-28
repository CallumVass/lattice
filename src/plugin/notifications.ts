// User-facing pipeline notifications.

import type { PipelineInstance, PipelinePause } from "../schema/index.js";

function buildUserNotification(options: { title: string; summary: string; nextSteps: string[] }): string {
  const nextStepsBlock = options.nextSteps.length
    ? ["", "### What to do next", "", ...options.nextSteps.map((s) => `- ${s}`)].join("\n")
    : "";

  return [`## ${options.title}`, "", options.summary, nextStepsBlock].filter(Boolean).join("\n");
}

function nativeQuestionStep(options: string, controlMapping: string): string {
  return `Native UX: call the \`question\` tool with options ${options}. After it returns, call \`lattice_control\` (${controlMapping}).`;
}

export function pauseMessage(pipelineName: string, pause: PipelinePause): string {
  const fallbackHint =
    "If `question` is unavailable or denied, tell the user to run one of the `/lattice ...` commands below.";

  if (pause.kind === "checkpoint") {
    return buildUserNotification({
      title: `Pipeline "${pipelineName}" paused - checkpoint`,
      summary: pause.prompt ?? pause.reason ?? `Stage "${pause.stageId}" completed and awaits approval.`,
      nextSteps: [
        nativeQuestionStep(
          "`Continue`, `Continue with guidance`, `Abort`, and `Status`",
          "`continue` with any guidance as `response`, `abort`, or `status`",
        ),
        `Continue with \`/lattice continue [message]\`; stage "${pause.nextStageId ?? "next"}" will start.`,
        "Inspect with `/lattice status` or cancel with `/lattice abort`.",
        fallbackHint,
      ],
    });
  }

  if (pause.kind === "blocked") {
    return buildUserNotification({
      title: `Pipeline "${pipelineName}" paused - blocked`,
      summary: pause.reason ?? `Stage "${pause.stageId}" is blocked.`,
      nextSteps: [
        nativeQuestionStep(
          "`Retry with guidance`, `Accept and continue`, `Abort`, and `Status`",
          "`retry` with guidance as `response`, `accept` with a `reason`, `abort`, or `status`",
        ),
        "Retry with `/lattice retry [message]`.",
        "Accept and continue with `/lattice accept [reason]`, or cancel with `/lattice abort`.",
        fallbackHint,
      ],
    });
  }

  if (pause.kind === "stuck") {
    return buildUserNotification({
      title: `Pipeline "${pipelineName}" paused - reset needed`,
      summary: pause.reason ?? `Stage "${pause.stageId}" appears stuck.`,
      nextSteps: [
        nativeQuestionStep("`Restart stage`, `Abort`, and `Status`", "`retry`, `abort`, or `status`"),
        "Restart with `/lattice retry`.",
        "Inspect with `/lattice status` or cancel with `/lattice abort`.",
        fallbackHint,
      ],
    });
  }

  return buildUserNotification({
    title: `Pipeline "${pipelineName}" paused - stage failed`,
    summary: pause.reason ?? `Stage "${pause.stageId}" failed.`,
    nextSteps: [
      nativeQuestionStep(
        "`Retry with guidance`, `Accept and continue`, `Abort`, and `Status`",
        "`retry` with guidance as `response`, `accept` with a `reason`, `abort`, or `status`",
      ),
      "Retry with `/lattice retry [message]`.",
      "Accept and continue with `/lattice accept [reason]`, or cancel with `/lattice abort`.",
      fallbackHint,
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
      "Start another pipeline with its generated slash command or `/lattice run <pipeline> <goal>`.",
    ],
  });
}

export function failureMessage(pipelineName: string, stageId: string | undefined, err: unknown): string {
  const errMsg = err instanceof Error ? err.message : String(err);
  return buildUserNotification({
    title: `Pipeline "${pipelineName}" failed`,
    summary: `Stage "${stageId ?? "unknown"}" errored:\n\n> ${errMsg}`,
    nextSteps: [
      `Rerun \`/${pipelineName}\` or \`/lattice run ${pipelineName} <goal>\` once the underlying cause is fixed.`,
      "Check the opencode log at `~/.local/share/opencode/log/` for the full stack trace.",
      "Use `/lattice status` to inspect active state if any remains.",
    ],
  });
}
