# Skills

Skills are markdown files that add targeted instructions to an agent's system prompt. Lattice uses OpenCode's native skill format.

## Where Lattice Looks

Project directories (in order, first wins):

- `.opencode/skills/`
- `.claude/skills/`
- `.agents/skills/`

Global directories (searched after project dirs):

- `~/.config/opencode/skills/`
- `~/.claude/skills/`
- `~/.agents/skills/`

Plus any extra paths you add via `skills.paths` in `.lattice/config.jsonc`.

## Precedence

First source wins by skill name. Project skills override global skills.

## Dynamic Selection

Stages can request:

- **Pinned skills**: always included.
- **Dynamic skills**: scored against the current goal, agent, and stage.

Lattice keeps pinned skills, then fills remaining slots with the highest-scoring dynamic skills up to the stage's `max`.

```ts
stage("plan", {
  agent: "planner",
  completion: "plan_created",
  skills: { dynamic: true, pinned: ["tdd"], max: 4 },
}),
```

## Authoring A Skill

Create a folder under one of the skill paths with a `SKILL.md` inside:

```
~/.config/opencode/skills/my-framework/SKILL.md
```

```md
---
name: my-framework
description: Patterns for My Framework
---

# My Framework

Instructions the agent should follow.
```

The `name` frontmatter must match the containing directory name. If frontmatter is missing, the filename becomes the skill name.
