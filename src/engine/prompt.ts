import type { StageDefinition, StageInstance } from "../schema/index.js";

export interface PromptContext {
  goal: string;
  slug: string;
  completedStages: StageInstance[];
  currentStage: StageDefinition;
}

export function composePrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  parts.push(`## Goal\n${ctx.goal}`);

  if (ctx.completedStages.length > 0) {
    parts.push("## Completed Stages");
    for (const s of ctx.completedStages) {
      parts.push(`- **${s.id}** (${s.agent}): ${s.summary ?? "completed"}`);
    }
  }

  parts.push(`## Current Stage: ${ctx.currentStage.id}\nAgent: ${ctx.currentStage.agent}`);

  if (ctx.currentStage.prompt) {
    const rendered = ctx.currentStage.prompt.replace("{{goal}}", ctx.goal);
    parts.push(rendered);
  }

  // Completion-specific instructions
  if (ctx.currentStage.completion === "plan_created") {
    parts.push(
      `**CRITICAL**: You MUST write your plan to the file \`.lattice/plans/${ctx.slug}.md\`. ` +
        "Create the directory if needed. The pipeline cannot advance until this file exists.",
    );
  }

  if (ctx.currentStage.completion === "plan_complete") {
    parts.push(
      `**CRITICAL**: Work through the plan at \`.lattice/plans/${ctx.slug}.md\`. ` +
        "Check off each item as you complete it by changing `- [ ]` to `- [x]`. " +
        "The pipeline cannot advance until all items are checked.",
    );
  }

  if (ctx.currentStage.completion === "tool_signal") {
    parts.push(
      "**CRITICAL**: When finished, call the `lattice_signal` tool with your verdict: " +
        '`lattice_signal(status: "complete")` for success, ' +
        '`lattice_signal(status: "approve")` to approve, ' +
        '`lattice_signal(status: "reject", reason: "...")` to reject, ' +
        'or `lattice_signal(status: "blocked", reason: "...")` if blocked. ' +
        "The pipeline cannot advance until you call this tool.",
    );
  }

  return parts.join("\n\n");
}
