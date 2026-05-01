# State And Completion

Lattice persists runtime data in `.lattice/` inside the target project.

## Runtime Files

```text
.lattice/
├── autostart.json   # optional one-shot request to start a pipeline in the next session
├── config.jsonc     # your config
├── signals/         # stage outcome signals written by lattice_signal
└── state/           # persisted pipeline instances (one file per run)
```

`.lattice/` is per-project runtime state and is intended to be gitignored. Lattice adds it to `.gitignore` on first write if it is not already listed.

Pipelines can write any other files they need (e.g. plans, drafts) under `.lattice/` or wherever their stage prompts direct.

`.lattice/autostart.json` is a transient one-shot request with `{ "pipeline": "<name>", "goal": "<goal>" }`. Lattice removes it after starting the pipeline successfully.

When a pipeline uses dynamic stage expansion, the persisted instance also records `runtimeStages`. This is the expanded stage list for that run only, so retries and approvals continue against the generated stages instead of re-reading the original placeholder definition.

## Completion Methods

- `idle`: stage completes when the session goes idle.
- `signal`: completes when the agent calls `lattice_signal` with one of its declared signals: `complete`, `pass`, `fail`, or `blocked`.

## Per-Stage Telemetry

Lattice subscribes to opencode's `message.updated` events and attributes assistant-turn tokens and cost to the currently-running stage. The data is persisted on each `StageInstance` under `telemetry`:

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
- Telemetry is attributed to the stage at `currentStageIndex` when its status is `running`. Messages arriving outside a running stage — e.g. during `paused` gates or after completion — are dropped.
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

If the pipeline is at a `pauseAfter` checkpoint, use `/lattice continue [response]` to unpause. The optional response is stored as `resumeContext`, included in the next stage prompt, then cleared when that stage starts.

`/lattice accept [reason]` is the inverse of retry: it marks the failed/blocked stage completed (with verdict `pass` and the optional reason appended to its summary) and advances to the next stage. Use this when you've reviewed the failure and decided it is acceptable as-is.

## Recovering A Stuck `running` Pipeline

If opencode dies or the plugin crashes while a stage is executing, the persisted instance ends up with `status: running` but no live session driving it. `/lattice retry` and `/lattice continue` both require `paused`, so the pipeline is wedged.

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
