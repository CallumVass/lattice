# State And Completion

Lattice persists runtime data in `.lattice/` inside the target project.

## Runtime Files

```text
.lattice/
├── config.jsonc
├── pipelines/
├── plans/
├── signals/
└── state/
```

## Completion Methods

- `idle`: stage completes when the session goes idle
- `plan_created`: completes when `.lattice/plans/<slug>.md` exists
- `plan_complete`: completes when every markdown checkbox in that plan is `- [x]`
- `tool_signal`: completes when the stage writes `.lattice/signals/<stage>.json`

## Why Plans Matter

The built-in `implement` pipeline uses a plan file as the contract between stages:

1. `planner` creates the plan
2. `implementor` works through it
3. the engine checks for completed checkboxes

If no checklist exists, the `plan_complete` stage will not advance.

## Retry Behavior

When a stage returns `reject` or `blocked`, the pipeline becomes `paused`.

`/lattice-retry` resets the rejected stage and every stage after it. If there is an earlier `implementor` stage, retry jumps back there first.

This lets the implementor fix issues before review reruns.
