# Custom Pipelines

Create pipeline files in `.lattice/pipelines/` inside the target project.

User pipelines override built-ins with the same `name`.

## Builder API

```ts
import { pipeline, ref, stage } from "@callumvass/lattice";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", {
      agent: "implementor",
      completion: "plan_complete",
      fork: false,
    }),
    ref("review-loop"),
  ],
});
```

Use `ref("review-loop")` — not `ref("review")` — when you want the reject-and-pause behavior that rewinds the implementor. The standalone `review` pipeline posts PR comments and completes; refing it inside an implementor loop is almost never what you want.

## Plain Object API

```ts
export default {
  name: "quick-fix",
  stages: [
    {
      id: "implement",
      type: "stage",
      agent: "implementor",
      completion: "plan_complete",
      fork: false,
    },
    { type: "pipeline", pipeline: "review-loop" },
  ],
};
```

## Stage Fields

- `id`: unique stage id inside the pipeline
- `agent`: OpenCode agent name to run
- `completion`: one of `idle`, `plan_created`, `plan_complete`, `tool_signal`
- `fork`: reuse prior session context when `true`
- `skills`: optional pinned or dynamic skill selection
- `prompt`: extra instructions appended to the stage prompt

## Pipeline Composition

Use `ref("<pipeline-name>")` or `{ type: "pipeline", pipeline: "<pipeline-name>" }` to inline another pipeline's stages. Built-in names you can ref: `review-loop` (for implementor loops), `review` (only if you actually want the PR-comment poster), `architecture`.

Nested pipelines are flattened at runtime. Circular references are rejected.

## Result

A pipeline named `quick-fix` registers a `/quick-fix <goal>` command automatically.
