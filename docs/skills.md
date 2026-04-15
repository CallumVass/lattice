# Skills

Skills are markdown files that add targeted instructions to an agent's system prompt.

Bundled skills in this repo:

- `tdd`
- `code-review`
- `opensrc`

## Where Lattice Looks

Project directories:

- `.opencode/skills/`
- `.claude/skills/`
- `.agents/skills/`

Global directories:

- `~/.config/opencode/skills/`
- `~/.claude/skills/`
- `~/.agents/skills/`

It also loads bundled skills from this package and any extra paths from config.

## Precedence

Earlier sources win by skill name.

That means project skills override global skills, and global skills override bundled skills.

## Dynamic Selection

Stages can request:

- pinned skills: always included
- dynamic skills: scored against the current goal, agent, and stage

Lattice keeps pinned skills, then fills remaining slots with the highest-scoring dynamic skills.

## Authoring A Skill

```md
---
name: my-framework
description: Patterns for My Framework
---

# My Framework

Instructions the agent should follow.
```

If frontmatter is missing, the filename becomes the skill name.
