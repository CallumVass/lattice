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
- Because lattice runs stages sequentially, this handles sub-agents and forked subtasks uniformly: any assistant message completing during a stage's lifetime belongs to that stage, regardless of session id.
- Retries accumulate onto the same stage's telemetry — they add to total cost/time, matching what a user actually paid.

## Retry Behavior

When a stage signals `reject` or `blocked`, the pipeline becomes `paused`.

`/lattice-retry` resets the rejected stage and every stage after it. If there is an earlier `implementor`-typed stage, retry jumps back there first — so the implementor can fix issues before review reruns.

If no stage is rejected (the pipeline is merely at a `pauseAfter` gate), `/lattice-retry` just unpauses and the engine moves on to the next stage.
