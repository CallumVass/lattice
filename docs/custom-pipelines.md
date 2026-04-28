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
- `pauseAfter`: `boolean | { prompt?: string; hardGate?: boolean }` — pause the pipeline after this stage completes. `true` renders a generic pause message; `{ prompt }` renders the given body verbatim (with `{{summary}}` / `{{reason}}` replaced by the stage's completion summary). The pause is released by `/lattice-approve`. Set `hardGate: true` to require a user-typed slash command to release — see [Hard gates](#hard-gates) below.
- `postHook`: `{ commands: string[]; maxRetries?: number }` — shell commands to run after the stage signals completion but before advancing. On failure the agent is asked to fix it; see [`state-and-completion.md`](state-and-completion.md#post-hooks).
- `expand`: dynamic stage expansion config — replaces this placeholder stage with stages rendered from a project-local JSON manifest when the placeholder becomes current. See [Dynamic stage expansion](#dynamic-stage-expansion).
- `skills`: optional pinned or dynamic skill selection (see [`skills.md`](skills.md))
- `prompt`: extra instructions appended to the stage prompt. Use this to tell the agent about pipeline-specific wiring: what output format to produce, where to write files, etc.
- `isRewindTarget`: `boolean` — opt this stage in as the rewind destination when a downstream stage rejects. Defaults to the legacy rule (rewind to the nearest upstream stage whose agent is literally named `implementor`). See [Reject rewinds](#reject-rewinds).
- `maxRewinds`: `number` — cap on how many times this stage may be rewound-to. On exhaustion, `lattice_retry` pauses the pipeline with a cap-exhausted message instead of looping. Undefined = unlimited.

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
      "Reply `/lattice-approve` to proceed, or `/lattice-approve <edits>` with changes.",
    ].join("\n"),
  },
});
```

`{{summary}}` and `{{reason}}` (aliases) expand to the stage's `lattice_signal` `reason`. If you need no substitution, omit the templates. Lattice wraps the body in the standard agent-guard envelope so the orchestrator doesn't auto-act on the notification.

## Hard gates

Soft pauses (`pauseAfter: true` or `pauseAfter: { prompt }`) are *advisory*: lattice asks the orchestrator to wait for the user, but the orchestrator can still call `lattice_approve` on its own if it misreads the pause message. For critical approval steps — plan sign-off, destructive actions, PR comment posting — use a hard gate:

```ts
stage("approve-pr-comments", {
  agent: "pr-review-composer",
  completion: "tool_signal",
  signals: ["complete"],
  pauseAfter: {
    prompt: "Review the proposed comments above. Approve to post them to GitHub.",
    hardGate: true,
  },
});
```

A hard gate refuses `lattice_approve` (and `lattice_retry`) unless the user literally types `/lattice-approve` (or `/lattice-retry`) in the opencode TUI. The plugin observes the slash command through opencode's `command.execute.before` hook and stamps a short-lived token on the active instance; the release tool consumes the token to proceed. Orchestrator tool calls don't carry this signal, so they can't proxy the release.

Hard gates are the right choice when the cost of a false auto-proceed is material (irreversible action, PR posted to the wrong people, destructive filesystem change). Soft pauses remain fine for "review this plan, come back when ready."

## Reject rewinds

When a downstream review stage emits `reject`, lattice rewinds the pipeline back to a target stage so it can address the findings. The target is chosen in this order:

1. If any upstream stage has `isRewindTarget: true`, the nearest such stage is the target.
2. Otherwise, the legacy rule fires: rewind to the nearest upstream stage whose agent is literally named `implementor`.
3. If neither applies, lattice rewinds to the rejected stage itself.

Mark a rewind target explicitly when the stage doing the work isn't named `implementor` — e.g. a ticket-authoring stage, a research stage, anything the orchestrator shouldn't share a name with:

```ts
stage("author-ticket", {
  agent: "ticket-author",
  completion: "tool_signal",
  signals: ["complete"],
  isRewindTarget: true,
  maxRewinds: 2, // optional cap
});
```

`maxRewinds` bounds the rewind loop. When the cap is reached, lattice leaves the pipeline paused with a message pointing the user at `/lattice-proceed` (accept the rejection and advance) or `/lattice-abort`. Without a cap, the loop runs until the orchestrator's ack budget or wall-clock budget runs out — which is almost never the right failure mode for a stuck pipeline.

## Pipeline Composition

Use `ref("<pipeline-name>")` or `{ type: "pipeline", pipeline: "<pipeline-name>" }` to inline another pipeline's stages. Nested pipelines are flattened at load time. Circular references are rejected.

## Dynamic Stage Expansion

Use `expand` when one planning stage writes a manifest and the next part of the pipeline should fan out into one stage per manifest item. The stage containing `expand` is only a placeholder: when it becomes the current pending stage, Lattice reads the manifest, renders the template once per item, replaces the placeholder in the active run, and persists the expanded runtime pipeline on the instance.

```ts
stage("build-slices", {
  agent: "implementor",
  completion: "tool_signal",
  signals: ["complete", "blocked"],
  expand: {
    from: ".lattice/slices.json",
    arrayPath: "slices",
    maxItems: 8,
    template: {
      id: "build-{{index}}-{{id}}",
      type: "stage",
      agent: "implementor",
      completion: "tool_signal",
      signals: ["complete", "blocked"],
      fork: false,
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

A pipeline with `name: "quick-fix"` registers a `/quick-fix <goal>` slash command automatically. You can verify it loaded via `/lattice-status`.
