# Custom Pipelines

Pipeline files live in one of two places:

- `~/.config/opencode/lattice-pipelines/<name>.{ts,js,mjs}` — global, available in every project.
- `.opencode/lattice-pipelines/<name>.{ts,js,mjs}` — project-local, overrides a global pipeline with the same `name`.

Each file exports a pipeline definition as its default export. The filename doesn't need to match the pipeline's `name`, but it usually does.

## Builder API (typed)

```ts
import { parallel, pipeline, ref, stage } from "@callumvass/lattice/builder";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", {
      agent: "implementor",
      completion: "signal",
      signals: ["complete", "blocked"],
      context: "isolated",
    }),
    parallel("reviewers", {
      stages: [
        stage("security-review", {
          agent: "security-reviewer",
          completion: "signal",
          signals: ["complete", "blocked"],
          completedContext: "summaries",
        }),
        stage("quality-review", {
          agent: "quality-reviewer",
          completion: "signal",
          signals: ["complete", "blocked"],
          completedContext: "summaries",
        }),
      ],
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
      completion: "signal",
      signals: ["complete", "blocked"],
      context: "isolated",
    },
    {
      type: "parallel",
      id: "reviewers",
      stages: [
        {
          id: "security-review",
          type: "stage",
          agent: "security-reviewer",
          completion: "signal",
          signals: ["complete", "blocked"],
          context: "isolated",
        },
        {
          id: "quality-review",
          type: "stage",
          agent: "quality-reviewer",
          completion: "signal",
          signals: ["complete", "blocked"],
          context: "isolated",
        },
      ],
    },
    { type: "pipeline", pipeline: "review-loop" },
  ],
};
```

Tradeoff: no autocomplete, no compile-time check that `signals` matches the completion method, and no typed refactoring. The runtime schema still rejects invalid shapes.

## Stage Fields

- `id`: unique stage id inside the pipeline
- `agent`: OpenCode agent name to run (must match an agent discoverable under `agents/`)
- `completion`: `idle` or `signal`
- `signals`: **required for `signal` stages**. Declares the verdicts this stage may emit. Any of `"complete" | "pass" | "fail" | "blocked"`. Tailors the engine-injected signalling instructions the agent sees, and `lattice_signal` refuses undeclared statuses.
- `context`: `"isolated"` starts a cold subtask; `"shared"` reuses the current conversation context. Defaults to `"isolated"`.
- `completedContext`: `"full" | "summaries" | "none"` — controls how much prior-stage completion context is injected into this stage's prompt. Defaults to `"full"`. Use `"none"` for fresh-context slice stages that read explicit handoff files instead of accumulated summaries.
- `pauseAfter`: `boolean | { prompt?: string }` — pause the pipeline after this stage completes. `true` renders a generic checkpoint message; `{ prompt }` renders the given body with `{{summary}}` / `{{reason}}` replaced by the stage's completion summary. The pause is released through the question gate or with `/lattice continue`.
- `expand`: dynamic stage expansion config — replaces this placeholder stage with stages rendered from a project-local JSON manifest when the placeholder becomes current. See [Dynamic stage expansion](#dynamic-stage-expansion).
- `skills`: optional pinned or dynamic skill selection (see [`skills.md`](skills.md))
- `prompt`: extra instructions appended to the stage prompt. Use this to tell the agent about pipeline-specific wiring: what output format to produce, where to write files, etc.
- `isRewindTarget`: `boolean` — opt this stage in as the rewind destination when a downstream stage fails or blocks. If no upstream stage is marked, the failed/blocked stage retries itself. See [Fail rewinds](#fail-rewinds).
- `maxRewinds`: `number` — cap on how many times this stage may be rewound-to. On exhaustion, `/lattice retry` leaves the pipeline paused with a cap-exhausted message instead of looping. Undefined = unlimited.

## Completion Methods

- `idle` — the stage completes when the agent session goes idle (no further tool calls or messages).
- `signal` — the stage completes when the agent calls `lattice_signal` with one of its declared `signals`. The engine automatically injects the signalling instructions into every `signal` stage's prompt, listing only the declared verdicts, so the agent knows exactly how to finish.

## Signal vocabulary

| Signal | Meaning | Engine behaviour |
| --- | --- | --- |
| `complete` | Work finished successfully | Pipeline advances |
| `pass` | Verdict: pass | Pipeline advances |
| `fail` | Verdict: fail | Pipeline pauses for user action |
| `blocked` | Cannot continue | Pipeline pauses for user action |

Declare only the verdicts relevant to each stage. Examples:

```ts
// work stage — finishes successfully or blocks
signals: ["complete", "blocked"];

// verdict stage — passes or fails (no notion of "just done")
signals: ["pass", "fail"];

// open-ended: all four outcomes possible
signals: ["complete", "pass", "fail", "blocked"];
```

## Custom pause prompts

When a stage pauses for human interaction (approval, edit, clarification), use the object form of `pauseAfter` to write the message the user sees:

```ts
stage("plan", {
  agent: "planner",
  completion: "signal",
  signals: ["complete"],
  pauseAfter: {
    prompt: [
      "Review the draft at `.lattice/plans/implement.md`.",
      "",
      "Agent said: {{summary}}",
      "",
      "Reply `/lattice continue` to proceed, or `/lattice continue <edits>` with changes.",
    ].join("\n"),
  },
});
```

`{{summary}}` and `{{reason}}` (aliases) expand to the stage's `lattice_signal` `reason`. If you need no substitution, omit the templates. Lattice posts a compact decision prompt and asks the build agent to use OpenCode's native `question` tool when available. The question includes an action choice and optional free-text guidance.

## Approval Checkpoints

`pauseAfter` creates an explicit checkpoint in the persisted instance. Resume through the question gate or with `/lattice continue [response]`, which records optional guidance as `resumeContext` and includes it in the next stage prompt.

For critical actions, model the approval as a checkpoint plus an explicit follow-up stage that performs the action after the user approves the question gate.

## Fail Rewinds

When a downstream review stage emits `fail` or `blocked`, lattice rewinds the pipeline back to a target stage so it can address the findings. The target is chosen in this order:

1. If any upstream stage has `isRewindTarget: true`, the nearest such stage is the target.
2. Otherwise, lattice retries the failed or blocked stage itself.

Mark a rewind target explicitly when a downstream reviewer should send work back to an earlier stage:

```ts
stage("author-ticket", {
  agent: "ticket-author",
  completion: "signal",
  signals: ["complete"],
  isRewindTarget: true,
  maxRewinds: 2, // optional cap
});
```

`maxRewinds` bounds the rewind loop. When the cap is reached, lattice leaves the pipeline paused with a message pointing the user at `/lattice accept` (accept the failure and advance) or `/lattice abort`. Without a cap, the loop runs until the orchestrator's ack budget or wall-clock budget runs out — which is almost never the right failure mode for a stuck pipeline.

## Pipeline Composition

Use `ref("<pipeline-name>")` or `{ type: "pipeline", pipeline: "<pipeline-name>" }` to inline another pipeline's stages. Nested pipelines are flattened at load time. Circular references are rejected.

## Parallel Groups

Use `parallel("<group-id>", { stages })` when multiple independent stages should run at the same pipeline point. Lattice launches the group members as isolated subtasks from the parent session, tracks each child session separately, and advances only after every member completes.

```ts
stage("prepare-review", {
  agent: "review-orchestrator",
  completion: "signal",
  signals: ["complete", "blocked"],
  prompt: "Inspect the diff and write reviewer briefs under `.lattice/review/`.",
}),

parallel("reviewers", {
  maxConcurrency: 4,
  stages: [
    stage("security", {
      agent: "security-reviewer",
      completion: "signal",
      signals: ["complete", "blocked"],
      completedContext: "summaries",
      prompt: "Review security concerns. Write findings to `.lattice/review/security.md`.",
    }),
    stage("scope", {
      agent: "scope-reviewer",
      completion: "signal",
      signals: ["complete", "blocked"],
      completedContext: "summaries",
      prompt: "Review scope and product fit. Write findings to `.lattice/review/scope.md`.",
    }),
    stage("quality", {
      agent: "quality-reviewer",
      completion: "signal",
      signals: ["complete", "blocked"],
      completedContext: "summaries",
      prompt: "Review code quality and maintainability. Write findings to `.lattice/review/quality.md`.",
    }),
  ],
}),

stage("review-verdict", {
  agent: "review-orchestrator",
  completion: "signal",
  signals: ["pass", "fail", "blocked"],
  prompt: "Read `.lattice/review/*.md` and produce the final review verdict.",
});
```

Parallel group rules:

- Members must use `context: "isolated"`; shared-context parallelism is rejected because multiple prompts would compete in the same conversation.
- Members cannot use `pauseAfter`; put checkpoints before or after the group.
- `maxConcurrency` is optional. Omit it to launch every member together, or set it to a positive integer to cap active subtasks.
- In reviewer swarms, worker stages should usually signal `complete` after writing findings. Put `pass` or `fail` on the follow-up orchestrator stage so all perspectives are collected before the pipeline pauses or rewinds.
- `completedContext` for group members only includes stages before the group. A later worker does not inherit another worker's summary, preserving reviewer independence when `maxConcurrency` is lower than the group size.

## Dynamic Stage Expansion

Use `expand` when one planning stage writes a manifest and the next part of the pipeline should fan out into one stage per manifest item. The stage containing `expand` is only a placeholder: when it becomes the current pending stage, Lattice reads the manifest, renders the template once per item, replaces the placeholder in the active run, and persists the expanded runtime pipeline on the instance.

```ts
stage("build-slices", {
  agent: "implementor",
  completion: "signal",
  signals: ["complete", "blocked"],
  expand: {
    from: ".lattice/slices.json",
    arrayPath: "slices",
    maxItems: 8,
    template: {
      id: "build-{{index}}-{{id}}",
      type: "stage",
      agent: "implementor",
      completion: "signal",
      signals: ["complete", "blocked"],
      context: "isolated",
      skills: { dynamic: true, max: 3 },
      prompt: "Implement {{title}} using {{file}} as the slice brief. Keep {{manifest.invariant}} true.",
    },
  },
});
```

Manifest example:

```json
{
  "slices": [
    { "index": 1, "id": "auth", "title": "Authentication", "file": ".lattice/slices/01-auth.md" }
  ],
  "invariant": "public APIs remain backwards-compatible"
}
```

Expansion details:

- `from` must be a project-relative JSON path. Absolute paths and `..` segments are rejected.
- `arrayPath` is a dot-separated path to the manifest array, such as `slices` or `plan.slices`.
- `maxItems` is required for safety and is capped at `50` by the schema.
- `template` is validated as a normal stage definition after rendering.
- Template strings can reference manifest item fields with `{{field}}`. Lattice also provides `{{position}}`, a 1-based array position, and `{{manifest.path}}` for values elsewhere in the manifest.
- Rendered stage ids are normalized to lowercase kebab-case and must be unique.
- If the template includes `skills: { dynamic: true }`, skill selection runs separately for each rendered stage after interpolation. The rendered stage id and prompt are used for scoring, so different manifest items can receive different dynamic skills even though they came from the same placeholder.

## Result

A pipeline with `name: "quick-fix"` registers a `/quick-fix <goal>` slash command automatically. You can verify it loaded via `/lattice status`.

For a complete working starter with pipeline, agents, and a skill, see [`../examples/quick-fix`](../examples/quick-fix).
