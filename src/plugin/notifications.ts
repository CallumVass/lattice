// User-facing pipeline notifications.

import type { PipelineInstance, PipelinePause } from "../schema/index.js";

const NO_EXTRA_GUIDANCE = "No extra guidance";
const MAX_CONTEXT_CHARS = 900;

interface PauseAction {
  label: string;
  description: string;
  controlAction: "status" | "continue" | "retry" | "accept" | "abort";
  guidanceTarget?: "response" | "reason";
}

function buildUserNotification(options: { title: string; summary: string; nextSteps: string[] }): string {
  const nextStepsBlock = options.nextSteps.length
    ? ["", "### Next steps", "", ...options.nextSteps.map((s) => `- ${s}`)].join("\n")
    : "";

  return [`## ${options.title}`, "", options.summary, nextStepsBlock].filter(Boolean).join("\n");
}

function pauseActions(pause: PipelinePause): PauseAction[] {
  if (pause.kind === "checkpoint") {
    return [
      {
        label: "Continue",
        description: `Start ${pause.nextStageId ? `stage ${pause.nextStageId}` : "the next stage"}.`,
        controlAction: "continue",
        guidanceTarget: "response",
      },
      { label: "Abort", description: "Stop this pipeline.", controlAction: "abort" },
      { label: "Status", description: "Show current pipeline state.", controlAction: "status" },
    ];
  }

  if (pause.kind === "stuck") {
    return [
      {
        label: "Restart stage",
        description: "Restart the stuck stage.",
        controlAction: "retry",
        guidanceTarget: "response",
      },
      { label: "Abort", description: "Stop this pipeline.", controlAction: "abort" },
      { label: "Status", description: "Show current pipeline state.", controlAction: "status" },
    ];
  }

  return [
    {
      label: "Retry",
      description: "Rewind and retry the failed or blocked work.",
      controlAction: "retry",
      guidanceTarget: "response",
    },
    {
      label: "Accept and continue",
      description: "Treat this result as acceptable and advance.",
      controlAction: "accept",
      guidanceTarget: "reason",
    },
    { label: "Abort", description: "Stop this pipeline.", controlAction: "abort" },
    { label: "Status", description: "Show current pipeline state.", controlAction: "status" },
  ];
}

function pauseState(pause: PipelinePause): string {
  if (pause.kind === "checkpoint") return "checkpoint";
  if (pause.kind === "blocked") return "blocked";
  if (pause.kind === "stuck") return "reset needed";
  return "stage failed";
}

function normalizeContext(value: string | undefined): string {
  const compact = (value ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= MAX_CONTEXT_CHARS) return compact;
  return `${compact.slice(0, MAX_CONTEXT_CHARS).trimEnd()}\n[truncated]`;
}

function actionOptions(actions: PauseAction[]): string {
  return actions.map((action) => `${action.label} (${action.description})`).join("; ");
}

function actionMappings(actions: PauseAction[]): string {
  return actions
    .map((action) => {
      const guidance = action.guidanceTarget ? `; pass extra guidance as ${action.guidanceTarget} when provided` : "";
      return `${action.label} -> lattice_control action "${action.controlAction}"${guidance}.`;
    })
    .join("\n");
}

function fallbackCommands(actions: PauseAction[]): string {
  const commands = actions.map((action) => `/lattice ${action.controlAction}`).join(", ");
  return `If the question tool is unavailable, briefly tell the user to run one of: ${commands}.`;
}

export function pauseMessage(pipelineName: string, pause: PipelinePause): string {
  const state = pauseState(pause);
  const context = normalizeContext(pause.prompt ?? pause.reason ?? `Stage "${pause.stageId}" paused.`);
  const nextStage = pause.nextStageId ? `Next stage: ${pause.nextStageId}` : undefined;

  return [
    "Lattice needs your decision.",
    `Pipeline: ${pipelineName}`,
    `State: ${state}`,
    `Stage: ${pause.stageId}`,
    nextStage,
    context ? `Context: ${context}` : undefined,
    "OpenCode will ask what Lattice should do next and let you add optional guidance.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function pauseInstruction(pipelineName: string, pause: PipelinePause): string {
  const state = pauseState(pause);
  const actions = pauseActions(pause);
  const context = normalizeContext(pause.prompt ?? pause.reason ?? `Stage "${pause.stageId}" paused.`);
  const nextStage = pause.nextStageId ? `Next stage: ${pause.nextStageId}` : undefined;

  return [
    "Lattice is paused and needs a user decision.",
    `Pipeline: ${pipelineName}`,
    `State: ${state}`,
    `Stage: ${pause.stageId}`,
    nextStage,
    context ? `Context: ${context}` : undefined,
    "",
    "Call the question tool now with exactly two questions in one call. Do not call lattice_control before the user answers.",
    "Question 1 header: Action",
    `Question 1 text: include the decision context above, then ask "What should Lattice do next?"`,
    `Question 1 options: ${actionOptions(actions)}.`,
    "Question 2 header: Guidance",
    `Question 2 text: Any extra guidance?`,
    `Question 2 options: ${NO_EXTRA_GUIDANCE}. Enable custom/free-text answers.`,
    `When the answer to Question 2 is "${NO_EXTRA_GUIDANCE}" or empty, omit response/reason. Otherwise use the user's guidance for actions that accept it.`,
    "After the question returns, call lattice_control using this mapping:",
    actionMappings(actions),
    fallbackCommands(actions),
  ]
    .filter(Boolean)
    .join("\n");
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
