# Quick Fix Example

This is a copy-paste starter project for a small implementation pipeline.

## Copy Into A Project

From this example directory, copy the `.opencode` folder into your target project:

```bash
cp -R .opencode <your-project>/
cd <your-project>
npm install --save-dev @callumvass/lattice
```

Register the plugin in the project's `opencode.json` if it is not already registered:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

Expected files after copying:

```text
.opencode/
├── agents/
│   ├── fix-implementor.md
│   ├── fix-planner.md
│   └── fix-reviewer.md
├── lattice-pipelines/
│   └── quick-fix.js
└── skills/
    └── focused-change/
        └── SKILL.md
```

## Run It

Inside OpenCode, verify the pipeline loaded:

```text
/lattice doctor
```

Then ask OpenCode:

```text
/quick-fix fix the failing checkout total test
```

The pipeline plans, pauses for approval, implements, and then reviews the change. The reviewer can signal `pass`, `fail`, or `blocked`; use `/lattice retry` after a failure to return to the implementation stage.

If `/quick-fix` is missing, run `/lattice status` to see loaded pipelines and `/lattice doctor` to see skipped-file diagnostics. The pipeline imports `@callumvass/lattice/builder`, so the package must be installed in the project where this `.opencode` folder lives.
