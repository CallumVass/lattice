# What Lattice Does

Lattice is an OpenCode plugin and TypeScript library for running agent pipelines.

At a high level it does five things:

1. Registers slash commands from pipeline definitions.
2. Starts the right agent for each stage.
3. Decides whether a stage should reuse context or start cold.
4. Injects relevant skills into the active agent.
5. Persists pipeline state so runs survive restarts.

## Built-in Pipelines

`implement`

```text
plan -> arch-review -> implement -> refactor -> review-loop (code-review -> review-judge)
```

`review` (standalone PR review — posts validated findings as inline comments, never halts)

```text
code-review -> pr-review-judge -> post-comments
```

`review-loop` (internal — used by `/implement`, rejects pause the pipeline for implementor retry)

```text
code-review -> review-judge
```

`architecture`, `investigate`, `create-jira-issues` are also built-in — see `run-a-pipeline.md`.

## Core Terms

- Pipeline: a named sequence of stages.
- Stage: one agent run with a completion rule.
- `fork: true`: continue in the same conversation context.
- `fork: false`: start a cold subtask for independence.
- Skill: markdown instructions injected into an agent's system prompt.

## What This Repo Contains

- `src/plugin/`: OpenCode plugin wiring, tools, commands, system transform
- `src/engine/`: pipeline state machine, prompt composition, persistence, completion checks
- `src/pipelines/`: built-in pipeline definitions (`implement`, `review`, `review-loop`, `architecture`, `investigate`, `create-jira-issues`)
- `src/builder/`: helper API for authoring pipelines in TypeScript
- `agents/`: bundled agent prompts
- `skills/`: bundled skills such as `tdd`, `code-review`, and `opensrc`

## Typical Flow

1. User runs `/implement <goal>`.
2. Lattice creates a pipeline instance in `.lattice/state/`.
3. It launches the first stage and waits for the stage's completion rule.
4. When the stage completes, it advances automatically.
5. If a stage returns `reject` or `blocked` (inside `/implement` or an `/architecture` review), the pipeline pauses until the user runs `/lattice-retry` or `/lattice-abort`. The standalone `/review` never pauses — it posts its findings and completes.
