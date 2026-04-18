# Custom Pipelines

Pipeline files live in one of two places:

- `~/.config/opencode/lattice-pipelines/<name>.ts` — global, available in every project.
- `.opencode/lattice-pipelines/<name>.ts` — project-local, overrides a global pipeline with the same `name`.

Each file exports a pipeline definition as its default export. The filename doesn't need to match the pipeline's `name`, but it usually does.

## Builder API (typed)

```ts
import { pipeline, ref, stage } from "@callumvass/lattice";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", {
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete", "blocked"],
      fork: false,
    }),
    ref("review-loop"),
  ],
});
```

`ref("<pipeline-name>")` inlines another pipeline's stages at runtime. The referenced pipeline must also be discoverable in one of the pipeline paths.

The builder requires `@callumvass/lattice` installed where the pipeline file can resolve it (`~/.config/opencode/` for global pipelines, your project root for `.opencode/` pipelines). See [`install.md`](install.md#pipeline-imports) for the one-time setup. If you prefer zero-install authoring, use the plain object form below.

## Plain Object API (no install)

Skips the typed builder — no imports, no `npm install`. Lattice validates the shape at load time via its schema.

```ts
export default {
  name: "quick-fix",
  stages: [
    {
      id: "implement",
      type: "stage",
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete", "blocked"],
      fork: false,
    },
    { type: "pipeline", pipeline: "review-loop" },
  ],
};
```

Tradeoff: no autocomplete, no compile-time check that `signals` matches the completion method, and no typed refactoring. The runtime schema still rejects invalid shapes.

## Stage Fields

- `id`: unique stage id inside the pipeline
- `agent`: OpenCode agent name to run (must match an agent discoverable under `agents/`)
- `completion`: `idle` or `tool_signal`
- `signals`: **required for `tool_signal` stages**. Declares the verdicts this stage may emit. Any of `"complete" | "approve" | "reject" | "blocked"`. Tailors the engine-injected signalling instructions the agent sees, and the engine warns if the agent signals outside the declared set.
- `fork`: reuse the current conversation context when `true`; start a cold subtask when `false`
- `pauseAfter`: `boolean | { prompt: string }` — pause the pipeline after this stage completes. `true` renders a generic pause message; `{ prompt }` renders the given body verbatim (with `{{summary}}` / `{{reason}}` replaced by the stage's completion summary).
- `skills`: optional pinned or dynamic skill selection (see [`skills.md`](skills.md))
- `prompt`: extra instructions appended to the stage prompt. Use this to tell the agent about pipeline-specific wiring: what output format to produce, where to write files, etc.

## Completion Methods

- `idle` — the stage completes when the agent session goes idle (no further tool calls or messages).
- `tool_signal` — the stage completes when the agent calls `lattice_signal` with one of its declared `signals`. The engine automatically injects the signalling instructions into every `tool_signal` stage's prompt, listing only the declared verdicts, so the agent knows exactly how to finish.

## Signal vocabulary

| Signal | Meaning | Engine behaviour |
| --- | --- | --- |
| `complete` | Work finished successfully | Pipeline advances |
| `approve` | Verdict: pass | Pipeline advances |
| `reject` | Verdict: fail | Pipeline pauses for user action |
| `blocked` | Cannot continue | Pipeline pauses for user action |

Declare only the verdicts relevant to each stage. Examples:

```ts
// work stage — finishes successfully or blocks
signals: ["complete", "blocked"];

// verdict stage — approves or rejects (no notion of "just done")
signals: ["approve", "reject"];

// open-ended: all four outcomes possible
signals: ["complete", "approve", "reject", "blocked"];
```

## Custom pause prompts

When a stage pauses for human interaction (approval, edit, clarification), use the object form of `pauseAfter` to write the message the user sees:

```ts
stage("plan", {
  agent: "planner",
  completion: "tool_signal",
  signals: ["complete"],
  pauseAfter: {
    prompt: [
      "Review the draft at `.lattice/plans/implement.md`.",
      "",
      "Agent said: {{summary}}",
      "",
      "Reply `/lattice-retry` to proceed, or `/lattice-retry <edits>` with changes.",
    ].join("\n"),
  },
});
```

`{{summary}}` and `{{reason}}` (aliases) expand to the stage's `lattice_signal` `reason`. If you need no substitution, omit the templates. Lattice wraps the body in the standard agent-guard envelope so the orchestrator doesn't auto-act on the notification.

## Pipeline Composition

Use `ref("<pipeline-name>")` or `{ type: "pipeline", pipeline: "<pipeline-name>" }` to inline another pipeline's stages. Nested pipelines are flattened at load time. Circular references are rejected.

## Result

A pipeline with `name: "quick-fix"` registers a `/quick-fix <goal>` slash command automatically. You can verify it loaded via `/lattice-status`.
