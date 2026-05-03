# Run A Pipeline

## Framework Commands

- `/lattice status`: show current pipeline status
- `/lattice run <pipeline> <goal>`: start a pipeline by name
- `/lattice continue [response]`: resume a pipeline paused at a `pauseAfter` checkpoint
- `/lattice retry [response]`: retry a failed or blocked stage — rewinds to a configured rewind target when one exists
- `/lattice accept [reason]`: accept a failed or blocked stage and advance past it
- `/lattice abort`: stop the active pipeline
- `/lattice reset`: recover a pipeline stuck in `running` state (e.g. opencode died mid-stage) — marks the stuck stage pending and pauses the pipeline so `/lattice retry` can pick it up

## Your Commands

Every pipeline you author gets a slash command matching its `name` field. Drop a pipeline at `.opencode/lattice-pipelines/<name>.ts` (project) or `~/.config/opencode/lattice-pipelines/<name>.ts` (global) and `/<name> <goal>` starts it.

The goal can be free text, an issue number, or a URL — it's passed straight through to the first stage.

## How A Run Proceeds

1. `/<pipeline-name> <goal>` invokes `lattice_control` with action `run`.
2. Lattice creates an instance under `.lattice/state/<id>.json`.
3. After the control command turn becomes idle, the first stage or parallel group runs. If `context: "isolated"`, a stage starts as a cold subtask; if `context: "shared"`, it injects into the current session.
4. Each active stage signals its outcome via the `lattice_signal` tool (`complete`, `pass`, `fail`, `blocked`).
5. Lattice advances to the next stage, or pauses if `pauseAfter: true` or the signal is `fail`/`blocked`. A parallel group advances only after every member completes. After isolated subtasks complete, the following non-group stage is dispatched from the parent session's next idle event rather than from a child session.
6. When the last stage signals `complete`, the pipeline completes and the active instance is cleared.

## Stage Context

- **Isolated stage** (`context: "isolated"`): starts fresh to avoid inheriting earlier reasoning — used for adversarial independence (reviewers, judges). This is the default.
- **Shared stage** (`context: "shared"`): keeps earlier context to avoid re-reading the repo — used for implementation stages that benefit from prior exploration.
- **Parallel group** (`parallel("id", { stages })`): starts multiple isolated stages together and joins after all of them complete. Use this for reviewer swarms, independent research slices, or batch checks.

## When A Pipeline Pauses

A pipeline pauses in two cases:

- **Checkpoint**: the current stage's definition has `pauseAfter: true` (or a custom pause config). The previous stage succeeded; the pipeline is waiting for user sign-off.
- **Failure/blocker**: a stage signaled `fail` or `blocked`. Choose retry (rewinds and retries), accept (treats the result as acceptable), or abort.

When possible, Lattice asks through OpenCode's `question` UI. The gate includes an action choice plus optional guidance. Guidance is passed to the next or retried stage as `resumeContext`, or used as the acceptance reason for `/lattice accept`.

### Checkpoints — `/lattice continue`

- `/lattice continue` to let the pipeline continue to the next stage.
- `/lattice continue <message>` to resume with a reply injected into the next stage's prompt (useful for extra requirements or answering a question the pause raised).
- `/lattice abort` to stop it.

After the checkpoint is released, Lattice starts the next pending stage automatically.

### Failures — `/lattice retry` / `/lattice accept`

For a failed or blocked stage, `/lattice retry` rewinds to a target stage and restarts it automatically. The target is picked in this order:

1. The nearest upstream stage with `isRewindTarget: true`.
2. Otherwise, the failed or blocked stage itself.

If the target carries a `maxRewinds` cap, `/lattice retry` refuses once the cap is reached and leaves the pipeline paused — use `/lattice accept` to accept the failure and advance, or `/lattice abort` to cancel. This avoids indefinite loops when a reviewer and a rewind target aren't converging. See [`custom-pipelines.md`](custom-pipelines.md#fail-rewinds) for authoring rewind targets.

If you've decided the failure is acceptable (e.g. intentional shared-file edits), use `/lattice accept [reason]` to mark the stage completed and advance to the next stage. The optional reason is recorded in the stage summary.

## Recovering A Stuck Pipeline — `/lattice reset`

If opencode dies while a stage is mid-run, the instance stays on disk with `status: running` but nothing is actually executing. `/lattice retry` and `/lattice continue` both refuse in this state (they need `paused`), and starting a new pipeline is blocked too.

`/lattice reset` is the escape hatch: it marks the stuck stage back to `pending` (clearing its `sessionId`, `startedAt`, `summary`, and verdict) and moves the pipeline to `paused`. Then `/lattice retry` restarts the stage from scratch.

Completed stages upstream are preserved. If you want to throw the pipeline away entirely, use `/lattice abort` instead — reset is for recovery, abort is for cancellation.
