import { readFile } from "node:fs/promises";
import type { CompletionMethod, SignalVerdict } from "../schema/index.js";

export interface CompletionContext {
  signalsDir: string;
  stageId: string;
}

export interface CompletionResult {
  complete: boolean;
  verdict?: "approve" | "reject" | "blocked";
  summary?: string;
  /** The raw signal emitted (for tool_signal). Absent for `idle` completion. */
  signal?: SignalVerdict;
}

interface Signal {
  status: SignalVerdict;
  reason?: string;
}

type Checker = (ctx: CompletionContext) => Promise<CompletionResult>;

const INCOMPLETE: CompletionResult = { complete: false };

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
    return { complete: true, verdict: "approve", signal: "approve", summary: signal.reason ?? "Approved" };
  }
  if (signal.status === "reject") {
    return { complete: true, verdict: "reject", signal: "reject", summary: signal.reason ?? "Rejected" };
  }
  if (signal.status === "blocked") {
    return { complete: true, verdict: "blocked", signal: "blocked", summary: signal.reason ?? "Blocked" };
  }

  return { complete: true, signal: "complete", summary: signal.reason ?? "Stage signalled completion" };
}

const checkers: Record<CompletionMethod, Checker> = {
  idle: checkIdle,
  tool_signal: checkToolSignal,
};

export function checkCompletion(method: CompletionMethod, ctx: CompletionContext): Promise<CompletionResult> {
  return checkers[method](ctx);
}
