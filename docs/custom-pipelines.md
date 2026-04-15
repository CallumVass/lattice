# Custom Pipelines

Create pipeline files in `.lattice/pipelines/` inside the target project.

User pipelines override built-ins with the same `name`.

## Builder API

```ts
import { pipeline, ref, stage } from "@lattice/opencode";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", {
      agent: "implementor",
      completion: "plan_complete",
      fork: false,
    }),
    ref("review"),
  ],
});
```

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
    { type: "pipeline", pipeline: "review" },
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

Use `ref("review")` or `{ type: "pipeline", pipeline: "review" }` to inline another pipeline's stages.

Nested pipelines are flattened at runtime. Circular references are rejected.

## Result

A pipeline named `quick-fix` registers a `/quick-fix <goal>` command automatically.
