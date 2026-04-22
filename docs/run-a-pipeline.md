# Run A Pipeline

## Framework Commands

- `/lattice-status`: show current pipeline status
- `/lattice-abort`: stop the active pipeline
- `/lattice-retry [response]`: resume a paused pipeline, optionally passing your reply to the pause reason
- `/lattice-proceed [reason]`: accept a rejected stage and advance past it (instead of looping back to the implementor)

## Your Commands

Every pipeline you author gets a slash command matching its `name` field. Drop a pipeline at `.opencode/lattice-pipelines/<name>.ts` (project) or `~/.config/opencode/lattice-pipelines/<name>.ts` (global) and `/<name> <goal>` starts it.

The goal can be free text, an issue number, or a URL — it's passed straight through to the first stage.

## How A Run Proceeds

1. `/<pipeline-name> <goal>` invokes the `lattice_run` tool.
2. Lattice creates an instance under `.lattice/state/<id>.json`.
3. The first stage runs. If `fork: false`, it starts as a cold subtask; if `fork: true`, it injects into the current session.
4. The stage signals its outcome via the `lattice_signal` tool (`complete`, `approve`, `reject`, `blocked`).
5. Lattice advances to the next stage, or pauses if `pauseAfter: true` or the signal is `reject`/`blocked`.
6. When the last stage signals `complete`, the pipeline completes and the active instance is cleared.

## Cold Start Vs Fork

- **Cold stage** (`fork: false`): starts fresh to avoid inheriting earlier reasoning — used for adversarial independence (reviewers, judges).
- **Forked stage** (`fork: true`): keeps earlier context to avoid re-reading the repo — used for implementation stages that benefit from prior exploration.

## When A Pipeline Pauses

A pipeline pauses in three cases:

- A stage signaled `reject` or `blocked`.
- The current stage's definition has `pauseAfter: true`.
- The engine is at a gate between pipelines.

Use:

- `/lattice-retry` to resume.
- `/lattice-retry <message>` to resume with a reply that gets injected into the next stage's prompt (useful to answer the pause reason).
- `/lattice-abort` to stop it.

For a rejected stage, `/lattice-retry` rewinds to a rewind-target stage and restarts. The target is picked in this order:

1. The nearest upstream stage with `isRewindTarget: true`.
2. Otherwise (backward-compat), the nearest upstream stage whose agent is literally named `implementor`.
3. Otherwise, the rejected stage itself.

If the target carries a `maxRewinds` cap, `/lattice-retry` refuses once the cap is reached and leaves the pipeline paused — use `/lattice-proceed` to accept the rejection and advance, or `/lattice-abort` to cancel. This avoids indefinite loops when a reviewer and a rewind target aren't converging. See [`custom-pipelines.md`](custom-pipelines.md#reject-rewinds) for authoring rewind targets.

If you've decided the rejection is acceptable (e.g. intentional shared-file edits), use `/lattice-proceed [reason]` to mark the rejected stage completed and advance to the next stage. The optional reason is recorded in the stage summary.

## Hard-Gated Pauses

A stage can declare `pauseAfter: { hardGate: true }` to refuse orchestrator-proxied retries. At a hard gate, the orchestrator cannot call `lattice_retry` on your behalf — you must type `/lattice-retry` (or `/lattice-retry <message>`) literally in the opencode TUI. Lattice observes the slash command through opencode's command hook and releases the gate.

Use hard gates for approval steps where a false auto-proceed would be expensive: plan sign-off, destructive actions, posting comments to GitHub. Soft pauses (`pauseAfter: true` or `pauseAfter: { prompt }` without `hardGate`) remain advisory and unchanged. See [`custom-pipelines.md`](custom-pipelines.md#hard-gates) for authoring hard gates.
