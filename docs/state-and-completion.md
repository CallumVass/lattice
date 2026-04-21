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

`/lattice-proceed [reason]` is the inverse of retry: it marks the rejected stage completed (with verdict `approve` and the optional reason appended to its summary) and advances to the next stage. Use this when you've reviewed the rejection and decided the findings are acceptable as-is.

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

Behaviour on failure:

- The failing command's output is injected back into the same stage as a follow-up, asking the agent to fix it before handing off again. Forked stages (`fork: true`) retry via an in-session prompt; cold-subtask stages (`fork: false`) retry as a fresh subtask so the retry doesn't silently land in the parent session.
- The signal file is cleared so the stage re-enters the normal completion loop — the agent works, re-signals, and the hook runs again.
- After `maxRetries` follow-ups still fail, the stage is marked `rejected` with the hook output as its summary and the pipeline pauses. `/lattice-retry` resumes with the usual rewind-to-implementor semantics.
- While the hook runs, lattice posts progress notifications (`running post-hook…`, `[1/N] <command>`, pass/fail) into the parent session so long-running checks don't look like the pipeline has hung.

`maxRetries` defaults to `1`. Set to `0` to fail fast on the first hook failure.
