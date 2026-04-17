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

## Learnings skill

When learnings capture is enabled (see `docs/configuration.md`), lattice renders stored findings for the current agent as a synthetic `codebase-learnings` skill and prepends it to the stage's skill list. It does not go through scanning or scoring — entries come from `.lattice/learnings.jsonl`, filtered by agent and confidence, capped at `learnings.maxPerAgent`. The reviewer cites matches back as `(learning: <id>)`.

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
