import { readFile } from "node:fs/promises";
import type { CompletionMethod, SignalVerdict } from "../schema/index.js";

export interface CompletionContext {
  signalsDir: string;
  legacySignalsDir?: string;
  stageId: string;
}

export interface CompletionResult {
  complete: boolean;
  verdict?: "pass" | "fail" | "blocked";
  summary?: string;
  /** The raw signal emitted for signal-based completion. Absent for `idle` completion. */
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

async function checkSignal(ctx: CompletionContext): Promise<CompletionResult> {
  const path = `${ctx.signalsDir}/${ctx.stageId}.json`;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    if (!ctx.legacySignalsDir) return INCOMPLETE;
    try {
      raw = await readFile(`${ctx.legacySignalsDir}/${ctx.stageId}.json`, "utf-8");
    } catch {
      return INCOMPLETE;
    }
  }

  const signal = JSON.parse(raw) as Signal;

  if (signal.status === "pass") {
    return { complete: true, verdict: "pass", signal: "pass", summary: signal.reason ?? "Passed" };
  }
  if (signal.status === "fail") {
    return { complete: true, verdict: "fail", signal: "fail", summary: signal.reason ?? "Failed" };
  }
  if (signal.status === "blocked") {
    return { complete: true, verdict: "blocked", signal: "blocked", summary: signal.reason ?? "Blocked" };
  }

  return { complete: true, signal: "complete", summary: signal.reason ?? "Stage signalled completion" };
}

const checkers: Record<CompletionMethod, Checker> = {
  idle: checkIdle,
  signal: checkSignal,
};

export function checkCompletion(method: CompletionMethod, ctx: CompletionContext): Promise<CompletionResult> {
  return checkers[method](ctx);
}
