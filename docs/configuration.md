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

## Notes

- The config format is JSONC, so comments are allowed.
- Config merging is shallow by top-level section, with project values winning.
