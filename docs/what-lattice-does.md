# What Lattice Does

Lattice is an OpenCode plugin and TypeScript library for running agent pipelines.

At a high level it does five things:

1. Registers slash commands from the pipeline definitions you supply.
2. Starts the right agent for each stage.
3. Decides whether a stage should reuse context or start cold.
4. Injects relevant skills into the active agent.
5. Persists pipeline state so runs survive restarts.

Lattice **does not ship agents, skills, or pipelines** — you provide them. Lattice is the orchestration layer on top of your own content.

## Core Terms

- **Pipeline**: a named sequence of stages (a TypeScript file with a default export).
- **Stage**: one agent run with a completion rule.
- `fork: true`: continue in the same conversation context.
- `fork: false`: start a cold subtask for independence.
- **Skill**: markdown instructions injected into an agent's system prompt.

## Where content lives

| Content | Project | Global |
| --- | --- | --- |
| Pipelines | `.opencode/lattice-pipelines/*.ts` | `~/.config/opencode/lattice-pipelines/*.ts` |
| Agents | `.opencode/agents/*.md` | `~/.config/opencode/agents/*.md` |
| Skills | `.opencode/skills/<name>/SKILL.md` | `~/.config/opencode/skills/<name>/SKILL.md` |

Project paths override global ones with the same name.

## What This Repo Contains

- `src/plugin/`: OpenCode plugin wiring, tools, commands, system transform
- `src/engine/`: pipeline state machine, prompt composition, persistence, completion checks
- `src/builder/`: helper API for authoring pipelines in TypeScript
- `src/skills/`: skill discovery and scoring
- `src/config/`: `.lattice/config.jsonc` loader

## Typical Flow

1. User runs a slash command registered by one of your pipelines (e.g. `/review <goal>`).
2. Lattice creates a pipeline instance in `.lattice/state/`.
3. It launches the first stage and waits for the stage's completion rule.
4. When the stage completes, it advances automatically.
5. If a stage has `pauseAfter`, the pipeline pauses for user sign-off — released with `/lattice-approve`.
6. If a stage returns `reject` or `blocked`, the pipeline pauses until the user runs `/lattice-retry` (rewind), `/lattice-proceed` (accept), or `/lattice-abort`.
