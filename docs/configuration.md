# Configuration

Lattice reads config from:

- `~/.config/lattice/config.jsonc`
- `.lattice/config.jsonc`

Project config overrides global config.

## Example

```jsonc
{
  "agents": {
    "implementor": {
      // Prefer model frontmatter in custom agent files for stable defaults.
      // Use this config model only for built-in agents or temporary overrides.
      "model": "anthropic/claude-sonnet-4-20250514",
      "promptSuffix": "Always use vitest."
    }
  },
  "pipelines": {
    "implement": {
      "stages": {
        "arch-review": { "skip": true },
        "plan": {
          "skills": {
            "pinned": ["tdd", "opensrc"],
            "dynamic": true,
            "max": 4
          }
        }
      }
    }
  },
  "skills": {
    "paths": ["/path/to/extra/skills"],
    "max": 4
  }
}
```

## What You Can Override

- Agent model per agent
- Extra prompt suffix per agent
- Stage skip flags per pipeline
- Stage skill settings per pipeline
- Extra skill directories (beyond the standard discovery paths)
- Global max number of injected skills
- Disable all skill injection (`skills.disabled: true`)

## Agent models

For custom OpenCode agents, prefer setting the default model in the agent's markdown frontmatter:

```md
---
description: "Code review - correctness and test coverage"
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.2
---
```

Lattice does not need to duplicate that value. If no Lattice config override is present, OpenCode applies the agent's own frontmatter model or the current session default.

Use `.lattice/config.jsonc` model overrides when you need to:

- Set a model for built-in agents such as `build` or `plan`.
- Temporarily override an APM-managed or shared agent without editing its markdown file.
- Run project-local experiments while leaving the agent definition unchanged.

Model selection precedence is:

1. Lattice config override: `agents.<name>.model`
2. OpenCode agent frontmatter: `model`
3. OpenCode/session default

## Disabling skill injection

Set `"skills": { "disabled": true }` at the top level to short-circuit skill injection for every stage. Pipeline files keep their inline `skills.pinned` lists; they are simply not consulted while the flag is on. Useful for A/B ablations (skills on vs skills off) without duplicating pipelines.

## Notes

- The config format is JSONC, so comments are allowed.
- Config merging is shallow by top-level section, with project values winning.
