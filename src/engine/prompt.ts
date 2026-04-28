import type { SignalVerdict, StageDefinition, StageInstance } from "../schema/index.js";

interface PromptContext {
  goal: string;
  completedStages: StageInstance[];
  currentStage: StageDefinition;
  resumeContext?: string;
}

const SIGNAL_LINES: Record<SignalVerdict, string> = {
  complete: '`lattice_signal(status: "complete", reason: "<summary>")` — work finished successfully.',
  pass: '`lattice_signal(status: "pass", reason: "<summary>")` — verdict: pass. The pipeline advances.',
  fail: '`lattice_signal(status: "fail", reason: "<why>")` — verdict: fail. The pipeline pauses for user action.',
  blocked:
    '`lattice_signal(status: "blocked", reason: "<why>")` — you cannot continue. The pipeline pauses for user action.',
};

export function composePrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  parts.push(`## Goal\n${ctx.goal}`);

  if (ctx.completedStages.length > 0) {
    parts.push("## Completed Stages");
    for (const s of ctx.completedStages) {
      parts.push(`- **${s.id}** (${s.agent}): ${s.summary ?? "completed"}`);
    }
  }

  if (ctx.resumeContext) {
    parts.push(
      `## User Response\nThe pipeline paused and the user has now replied. Treat this as the authoritative decision for this stage — act on it before doing anything else.\n\n${ctx.resumeContext}`,
    );
  }

  parts.push(`## Current Stage: ${ctx.currentStage.id}\nAgent: ${ctx.currentStage.agent}`);

  if (ctx.currentStage.prompt) {
    const rendered = ctx.currentStage.prompt.replace("{{goal}}", ctx.goal);
    parts.push(rendered);
  }

  if (ctx.currentStage.completion === "signal") {
    const signals = ctx.currentStage.signals;
    const lines = (signals ?? ["complete"]).map((s) => `- ${SIGNAL_LINES[s]}`).join("\n");
    const one = signals?.length === 1;
    parts.push(
      `**CRITICAL**: When finished, call the \`lattice_signal\` tool. ${
        one ? "The only valid outcome for this stage is:" : "Valid outcomes for this stage are:"
      }\n\n${lines}\n\nThe pipeline cannot advance until you call this tool.`,
    );
  }

  return parts.join("\n\n");
}
