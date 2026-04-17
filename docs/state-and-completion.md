# State And Completion

Lattice persists runtime data in `.lattice/` inside the target project.

## Runtime Files

```text
.lattice/
├── config.jsonc     # your config
├── plans/           # plan files written by plan_created / plan_complete stages
├── signals/         # stage outcome signals written by lattice_signal
└── state/           # persisted pipeline instances (one file per run)
```

`.lattice/` is per-project runtime state and is intended to be gitignored. Lattice adds it to `.gitignore` on first write if it is not already listed.

## Completion Methods

- `idle`: stage completes when the session goes idle.
- `plan_created`: completes when `.lattice/plans/<slug>.md` exists.
- `plan_complete`: completes when every markdown checkbox in that plan is `- [x]`.
- `tool_signal`: completes when the stage writes `.lattice/signals/<stage>.json` via the `lattice_signal` tool.

## Retry Behavior

When a stage signals `reject` or `blocked`, the pipeline becomes `paused`.

`/lattice-retry` resets the rejected stage and every stage after it. If there is an earlier `implementor`-typed stage, retry jumps back there first — so the implementor can fix issues before review reruns.

If no stage is rejected (the pipeline is merely at a `pauseAfter` gate), `/lattice-retry` just unpauses and the engine moves on to the next stage.
