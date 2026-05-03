# State And Completion

Lattice persists runtime data in `.lattice/` inside the target project.

## Runtime Files

```text
.lattice/
├── config.jsonc     # your config
├── signals/         # stage outcome signals written by lattice_signal, namespaced by run id
└── state/           # persisted pipeline instances (one file per run)
```

`.lattice/` is per-project runtime state and is intended to be gitignored. Lattice adds it to `.gitignore` on first write if it is not already listed.

Pipelines can write any other files they need (e.g. plans, drafts) under `.lattice/` or wherever their stage prompts direct.

When a pipeline uses dynamic stage expansion, the persisted instance also records `runtimeStages`. This is the expanded stage list for that run only, so retries and checkpoints continue against the generated stages instead of re-reading the original placeholder definition.

When a pipeline uses `parallel(...)`, Lattice flattens the group into normal stage instances annotated with runtime `parallelGroup` metadata on `runtimeStages` or the flattened pipeline definition. Each member still has its own `StageInstance`, `sessionId`, signal file, and telemetry.

## Completion Methods

- `idle`: stage completes when the stage's session goes idle.
- `signal`: completes when the agent calls `lattice_signal` with one of its declared signals: `complete`, `pass`, `fail`, or `blocked`.

## Per-Stage Telemetry

Lattice subscribes to opencode's `message.updated` events and attributes assistant-turn tokens and cost to the currently-running stage when the event belongs to that stage's session. The data is persisted on each `StageInstance` under `telemetry`:

```ts
telemetry?: {
  configuredModel?: string;
  configuredProvider?: string;
  observedModel?: string;
  observedProvider?: string;
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
- Telemetry is attributed to the stage at `currentStageIndex` when its status is `running` and the event session matches the stage session. Messages arriving outside a running stage — e.g. during `paused` gates, from unrelated sessions, or after completion — are dropped.
- For parallel groups, telemetry is attributed by child `sessionId`, so simultaneous reviewer subtasks accumulate separate costs and token counts.
- If opencode includes an assistant-message `agent`, telemetry is only counted when it matches the running stage's agent.
- If a stage has an agent model override, Lattice seeds `configuredModel` and `configuredProvider` from that override and keeps `model` and `provider` pinned to the configured values. Later message metadata is recorded separately as `observedModel` and `observedProvider`.
- If observed message metadata differs from a configured model override, Lattice logs a warning so users can spot provider fallback or alias resolution while preserving both configured and observed values.
- Retries accumulate onto the same stage's telemetry — they add to total cost/time, matching what a user actually paid.

## Retry Behavior

When a stage signals `fail` or `blocked`, the pipeline becomes `paused` and records explicit pause metadata on the instance.

`/lattice retry [response]` resets the failed/blocked stage and every stage after it, then rewinds to a target stage:

1. If an upstream stage has `isRewindTarget: true`, the nearest such stage is the target.
2. Otherwise, the failed/blocked stage itself retries.

The target stage's `rewindsUsed` counter increments on each accepted rewind. If the target declares `maxRewinds: N`, `/lattice retry` refuses once the counter reaches the cap and leaves the pipeline paused with a message pointing at `/lattice accept` or `/lattice abort`. Unbounded by default — set a cap on stages where a reviewer/target non-convergence is a realistic failure mode. See [`custom-pipelines.md`](custom-pipelines.md#fail-rewinds).

If a stage inside a parallel group fails or blocks and no upstream rewind target is configured, `/lattice retry` restarts the whole parallel group rather than only the one rejected member. This keeps the group outputs consistent for the downstream orchestrator.

If the pipeline is at a `pauseAfter` checkpoint, approve it through the question gate or use `/lattice continue [response]` to unpause. The optional response is stored as `resumeContext`, included in the next stage prompt, then cleared when that stage starts.

`/lattice accept [reason]` is the inverse of retry: it marks the failed/blocked stage completed (with verdict `pass` and the optional reason appended to its summary) and advances to the next stage. Use this when you've reviewed the failure and decided it is acceptable as-is.

## Recovering A Stuck `running` Pipeline

If opencode dies or the plugin crashes while a stage is executing, the persisted instance can end up with `status: running` but no live session driving it. If the crash happens while dispatching a stage, Lattice restores the run as a `stuck` pause automatically. Otherwise, use `/lattice reset`.

`/lattice reset` recovers from this: it marks the current running stage back to `pending` (clearing `sessionId`, `startedAt`, `completedAt`, `summary`, and `verdict`) and moves the pipeline to `paused` with pause kind `stuck`. Completed stages are untouched. Follow up with `/lattice retry` to restart the stuck stage from scratch, or `/lattice abort` to throw the run away.

Reset is for recovery only — it refuses if the pipeline is already `paused` (use `/lattice retry` or `/lattice continue`) or if there is no active pipeline.

## Verification Stages

Lattice does not run hidden shell commands after a stage completes. If checks should gate handoff, model them as an explicit verification stage so the command output, fixes, and final signal all happen in the normal OpenCode conversation.

```ts
stage("verify", {
  agent: "verifier",
  completion: "signal",
  signals: ["complete"],
  prompt: "Run `npm run check`. If it fails, fix the issues and rerun it before signalling complete.",
});
```

For reviewer-style verification, use `signals: ["pass", "fail", "blocked"]` and mark the implementation stage with `isRewindTarget: true` so `/lattice retry` returns to the work stage instead of retrying the verifier itself.
