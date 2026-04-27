# State And Completion

Lattice persists runtime data in `.lattice/` inside the target project.

## Runtime Files

```text
.lattice/
├── config.jsonc     # your config
├── signals/         # stage outcome signals written by lattice_signal
└── state/           # persisted pipeline instances (one file per run)
```

`.lattice/` is per-project runtime state and is intended to be gitignored. Lattice adds it to `.gitignore` on first write if it is not already listed.

Pipelines can write any other files they need (e.g. plans, drafts) under `.lattice/` or wherever their stage prompts direct.

When a pipeline uses dynamic stage expansion, the persisted instance also records `runtimeStages`. This is the expanded stage list for that run only, so retries and approvals continue against the generated stages instead of re-reading the original placeholder definition.

## Completion Methods

- `idle`: stage completes when the session goes idle.
- `tool_signal`: completes when the agent calls `lattice_signal` with `complete`, `approve`, `reject`, or `blocked`.

## Per-Stage Telemetry

Lattice subscribes to opencode's `message.updated` events and attributes assistant-turn tokens and cost to the currently-running stage. The data is persisted on each `StageInstance` under `telemetry`:

```ts
telemetry?: {
  model?: string;
  provider?: string;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUSD: number;     // pre-computed by opencode
  messageCount: number;
}
```

Attribution rules:

- Only authoritative assistant turns (`role === "assistant"` and `time.completed` set) are counted. Partial streaming frames are skipped.
- Telemetry is attributed to the stage at `currentStageIndex` when its status is `running`. Messages arriving outside a running stage — e.g. during `paused` gates or after completion — are dropped.
- If opencode includes an assistant-message `agent`, telemetry is only counted when it matches the running stage's agent.
- If a stage has an agent model override, Lattice seeds telemetry with the configured model/provider and does not overwrite those fields with later message metadata. Token and cost counters still accumulate from opencode events.
- Retries accumulate onto the same stage's telemetry — they add to total cost/time, matching what a user actually paid.

## Retry Behavior

When a stage signals `reject` or `blocked`, the pipeline becomes `paused`.

`/lattice-retry` resets the rejected stage and every stage after it, then rewinds to a rewind-target stage:

1. If an upstream stage has `isRewindTarget: true`, the nearest such stage is the target.
2. Otherwise (backwards-compat), if an upstream stage's agent is literally named `implementor`, that stage is the target.
3. Otherwise, the rejected stage itself retries.

The target stage's `rewindsUsed` counter increments on each accepted rewind. If the target declares `maxRewinds: N`, `/lattice-retry` refuses once the counter reaches the cap and leaves the pipeline paused with a message pointing at `/lattice-proceed` or `/lattice-abort`. Unbounded by default — set a cap on stages where a reviewer/target non-convergence is a realistic failure mode. See [`custom-pipelines.md`](custom-pipelines.md#reject-rewinds).

If no stage is rejected (the pipeline is at a `pauseAfter` gate), use `/lattice-approve` to unpause — the previous stage succeeded, this is an approval checkpoint. `/lattice-retry` also works at a gate for back-compat, but `/lattice-approve` reads better because no retry is happening. At a hard gate (`pauseAfter: { hardGate: true }`), either command only releases when a user-typed slash command is observed via opencode's command hook — orchestrator-proxied tool calls are refused. After a release, Lattice schedules the next pending stage immediately. See [`custom-pipelines.md`](custom-pipelines.md#hard-gates).

`/lattice-proceed [reason]` is the inverse of retry: it marks the rejected stage completed (with verdict `approve` and the optional reason appended to its summary) and advances to the next stage. Use this when you've reviewed the rejection and decided the findings are acceptable as-is.

## Recovering A Stuck `running` Pipeline

If opencode dies or the plugin crashes while a stage is executing, the persisted instance ends up with `status: running` but no live session driving it. `/lattice-retry` and `/lattice-approve` both require `paused`, so the pipeline is wedged.

`/lattice-reset` recovers from this: it marks the current running stage back to `pending` (clearing `sessionId`, `startedAt`, `completedAt`, `summary`, `verdict`, and `postHookRetriesUsed`) and moves the pipeline to `paused`. Completed stages are untouched. Follow up with `/lattice-retry` to restart the stuck stage from scratch, or `/lattice-abort` to throw the run away.

Reset is for recovery only — it refuses if the pipeline is already `paused` (use `/lattice-retry` or `/lattice-approve`) or if there is no active pipeline.

## Post-Hooks

A stage can declare a `postHook` to run shell commands after it signals completion but before the pipeline advances. Use this for lint, format, and test checks that should gate handoff to the next stage.

```ts
stage("implement", {
  agent: "implementor",
  completion: "tool_signal",
  signals: ["complete"],
  postHook: {
    commands: ["npm run lint", "npm run test"],
    maxRetries: 2,
  },
});
```

Commands run sequentially in the project directory; the first non-zero exit stops the chain and its combined stdout/stderr is captured.

Before running a post-hook, Lattice waits for the workspace to be quiet so late file writes are less likely to race the hook. After a passing hook, it checks the workspace again; if source files changed during or just after the hook, Lattice reruns the hook once as a recheck. Runtime/output directories such as `.git`, `.lattice`, `.opencode`, `node_modules`, `dist`, `coverage`, `bin`, and `obj` are ignored for this settling check.

Set `LATTICE_COMPLETION_SETTLE_MS` to tune the quiet window. The default is `5000`; set it to `0` to disable waiting.

Behaviour on failure:

- The failing command's output is injected back into the same stage as a follow-up, asking the agent to fix it before handing off again. Forked stages (`fork: true`) retry via an in-session prompt; cold-subtask stages (`fork: false`) retry as a fresh subtask so the retry doesn't silently land in the parent session.
- The signal file is cleared so the stage re-enters the normal completion loop — the agent works, re-signals, and the hook runs again.
- After `maxRetries` follow-ups still fail, the stage is marked `rejected` with the hook output as its summary and the pipeline pauses. `/lattice-retry` resumes with the usual rewind-target semantics (see [Retry Behavior](#retry-behavior) above).
- While the hook runs, lattice posts progress notifications (`running post-hook…`, `[1/N] <command>`, pass/fail) into the parent session so long-running checks don't look like the pipeline has hung.
- When the whole pipeline completes, lattice posts a notification instead of injecting a new agent prompt, so completion messages don't accidentally start follow-up agent work.

`maxRetries` defaults to `1`. Set to `0` to fail fast on the first hook failure.
