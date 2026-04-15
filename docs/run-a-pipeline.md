# Run A Pipeline

## Built-in Commands

- `/implement <goal>`: full delivery pipeline
- `/architecture <goal>`: architecture exploration pipeline
- `/review <goal>`: review-only pipeline
- `/lattice-status`: show current pipeline status
- `/lattice-abort`: stop the active pipeline
- `/lattice-retry`: resume a paused pipeline

The goal can be free text, an issue number, or a URL.

## What `/architecture` Does

```text
architecture-review
```

The architecture reviewer explores the repo, ranks architectural friction, and finishes by calling `lattice_signal`.

## What `/implement` Does

```text
plan -> arch-review -> implement -> refactor -> code-review -> review-judge
```

- `plan` writes `.lattice/plans/<goal-slug>.md`
- `implement` completes when every checklist item in that plan is checked
- review stages finish by calling `lattice_signal`

## What `/review` Does

```text
code-review -> review-judge
```

Both review stages use `lattice_signal` to report their result.

## Cold Start Vs Fork

- Cold stage: starts fresh to avoid inheriting earlier reasoning
- Forked stage: keeps earlier context to avoid re-reading the repo

In the built-in pipelines, implementation-oriented stages mostly fork, while review and architecture start cold.

## When A Pipeline Pauses

If a stage returns `reject` or `blocked`, the pipeline pauses.

Use:

- `/lattice-retry` to send the run back to the nearest `implementor` stage, or retry the rejected stage when none exists
- `/lattice-abort` to stop it
