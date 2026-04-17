# Custom Pipelines

Pipeline files live in one of two places:

- `~/.config/opencode/lattice-pipelines/<name>.ts` — global, available in every project.
- `.opencode/lattice-pipelines/<name>.ts` — project-local, overrides a global pipeline with the same `name`.

Each file exports a pipeline definition as its default export. The filename doesn't need to match the pipeline's `name`, but it usually does.

## Builder API

```ts
import { pipeline, ref, stage } from "@callumvass/lattice";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", {
      agent: "implementor",
      completion: "tool_signal",
      fork: false,
    }),
    ref("review-loop"),
  ],
});
```

`ref("<pipeline-name>")` inlines another pipeline's stages at runtime. The referenced pipeline must also be discoverable in one of the pipeline paths.

## Plain Object API

```ts
export default {
  name: "quick-fix",
  stages: [
    {
      id: "implement",
      type: "stage",
      agent: "implementor",
      completion: "tool_signal",
      fork: false,
    },
    { type: "pipeline", pipeline: "review-loop" },
  ],
};
```

## Stage Fields

- `id`: unique stage id inside the pipeline
- `agent`: OpenCode agent name to run (must match an agent discoverable under `agents/`)
- `completion`: `idle` or `tool_signal`
- `fork`: reuse the current conversation context when `true`; start a cold subtask when `false`
- `pauseAfter`: pause the pipeline after this stage completes (useful for approval gates)
- `skills`: optional pinned or dynamic skill selection (see [`skills.md`](skills.md))
- `prompt`: extra instructions appended to the stage prompt. Use this to tell the agent about pipeline-specific wiring: what output format to produce, where to write files, whether to use `reject` vs always `complete`, etc.

## Completion Methods

- `idle` — the stage completes when the agent session goes idle (no further tool calls or messages).
- `tool_signal` — the stage completes when the agent calls `lattice_signal` with one of `complete`, `approve`, `reject`, `blocked`. The engine automatically injects the signalling instructions into every `tool_signal` stage's prompt, so the agent always knows how to finish.

## Pipeline Composition

Use `ref("<pipeline-name>")` or `{ type: "pipeline", pipeline: "<pipeline-name>" }` to inline another pipeline's stages. Nested pipelines are flattened at load time. Circular references are rejected.

## Result

A pipeline with `name: "quick-fix"` registers a `/quick-fix <goal>` slash command automatically. You can verify it loaded via `/lattice-status`.
