import { readFile } from "node:fs/promises";
import type { CompletionMethod } from "../schema/index.js";

export interface CompletionContext {
  plansDir: string;
  signalsDir: string;
  slug: string;
  stageId: string;
}

export interface CompletionResult {
  complete: boolean;
  verdict?: "approve" | "reject" | "blocked";
  summary?: string;
}

interface Signal {
  status: "complete" | "approve" | "reject" | "blocked";
  reason?: string;
}

type Checker = (ctx: CompletionContext) => Promise<CompletionResult>;

const INCOMPLETE: CompletionResult = { complete: false };

async function checkPlanCreated(ctx: CompletionContext): Promise<CompletionResult> {
  const path = `${ctx.plansDir}/${ctx.slug}.md`;
  try {
    const content = await readFile(path, "utf-8");
    return { complete: true, summary: `Plan at ${path}:\n\n${content.trim()}` };
  } catch {
    return INCOMPLETE;
  }
}

async function checkPlanComplete(ctx: CompletionContext): Promise<CompletionResult> {
  const path = `${ctx.plansDir}/${ctx.slug}.md`;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return INCOMPLETE;
  }

  const checkboxes = content.match(/^- \[[ x]\]/gm);
  if (!checkboxes || checkboxes.length === 0) {
    return INCOMPLETE;
  }

  const allChecked = checkboxes.every((cb) => cb === "- [x]");
  if (!allChecked) {
    return INCOMPLETE;
  }

  return { complete: true, summary: `All ${checkboxes.length} items checked` };
}

async function checkIdle(): Promise<CompletionResult> {
  // idle completion: the session.idle event itself is the signal.
  // If we're being checked, the session went idle, so we're done.
  return { complete: true, summary: "Session idle" };
}

async function checkToolSignal(ctx: CompletionContext): Promise<CompletionResult> {
  const path = `${ctx.signalsDir}/${ctx.stageId}.json`;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return INCOMPLETE;
  }

  const signal = JSON.parse(raw) as Signal;

  if (signal.status === "approve") {
    return { complete: true, verdict: "approve", summary: signal.reason ?? "Approved" };
  }
  if (signal.status === "reject") {
    return { complete: true, verdict: "reject", summary: signal.reason ?? "Rejected" };
  }
  if (signal.status === "blocked") {
    return { complete: true, verdict: "blocked", summary: signal.reason ?? "Blocked" };
  }

  return { complete: true, summary: signal.reason ?? "Stage signalled completion" };
}

const checkers: Record<CompletionMethod, Checker> = {
  plan_created: checkPlanCreated,
  plan_complete: checkPlanComplete,
  idle: checkIdle,
  tool_signal: checkToolSignal,
};

export function checkCompletion(method: CompletionMethod, ctx: CompletionContext): Promise<CompletionResult> {
  return checkers[method](ctx);
}
