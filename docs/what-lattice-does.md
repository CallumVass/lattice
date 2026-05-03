# What Lattice Does

Lattice is an OpenCode plugin and TypeScript library for running agent pipelines.

At a high level it does five things:

1. Registers slash commands from the pipeline definitions you supply.
2. Starts the right agent or parallel sub-agent group for each pipeline step.
3. Decides whether a stage should reuse context or start cold.
4. Injects relevant skills into the active agent.
5. Persists pipeline state so runs survive restarts.

Lattice **does not ship agents, skills, or pipelines** — you provide them. Lattice is the orchestration layer on top of your own content.

## Core Terms

- **Pipeline**: a named sequence of stages and optional parallel groups (a TypeScript file with a default export).
- **Stage**: one agent run with a completion rule.
- **Parallel group**: multiple isolated stages launched together from the same parent session. The pipeline joins after every group member completes.
- `context: "shared"`: continue in the same conversation context.
- `context: "isolated"`: start a cold subtask for independence.
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
3. It launches the first stage or parallel group after the control command turn is idle, then waits for each active stage's completion rule.
4. When a single stage completes, it advances automatically. When a parallel group is active, Lattice waits until every group member completes before advancing.
5. If a stage has `pauseAfter`, the pipeline pauses for user sign-off through a question gate or `/lattice continue`.
6. If a stage returns `fail` or `blocked`, the pipeline pauses until the user chooses retry, accept, or abort through the question gate or `/lattice` commands.
