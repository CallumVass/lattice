# Troubleshooting

Start with `/lattice doctor`. It prints pipeline search paths, loaded pipeline names, load diagnostics, flattening errors, unsafe dynamic expansion paths, and missing pinned skills.

## Pipeline Command Missing

Check these first:

- The plugin is registered in `opencode.json`.
- The file is under `.opencode/lattice-pipelines/` or `~/.config/opencode/lattice-pipelines/`.
- The file extension is `.ts`, `.js`, or `.mjs`.
- The file has a default export.
- The exported pipeline `name` is lowercase alphanumeric with hyphens.

Run `/lattice status` to see loaded pipelines. If the pipeline is not listed, run `/lattice doctor` and inspect load diagnostics.

## Import Errors

If a pipeline uses the typed builder, install the package where the pipeline file resolves imports:

```bash
cd <project>
npm install --save-dev @callumvass/lattice
```

For global pipelines, install under `~/.config/opencode` instead. See [`install.md`](install.md#pipeline-imports).

## Schema Errors

Lattice validates pipeline and config files with strict schemas. Unknown keys are rejected. Common examples:

- Use `skills`, not `skillz`.
- Use `skills.disabled`, not `skills.disable`.
- Use `signals` only on `completion: "signal"` stages.
- Parallel group members must use `context: "isolated"` and cannot use `pauseAfter`.

## Missing Pinned Skills

`/lattice doctor` reports pinned skills that were not discovered. Check spelling and make sure the skill exists as `SKILL.md` under one of the standard paths or a configured `skills.paths` entry.

## Dynamic Expansion Fails

The manifest path in `expand.from` must be project-relative. Absolute paths and `..` segments are rejected.

Remember that expansion happens when the placeholder stage becomes current. It is normal for a manifest to be absent before an upstream planning stage writes it.

## Pipeline Stuck Running

If OpenCode or the plugin exits mid-stage, use `/lattice reset`. It moves the active running/dispatching stage back to pending and pauses the pipeline. Then use `/lattice retry` to restart it or `/lattice abort` to cancel.

## Signals Not Accepted

`lattice_signal` only accepts statuses declared by the current stage. If a stage declares `signals: ["complete"]`, a `fail` signal is refused. Add the signal to the stage definition if that outcome should be valid.
