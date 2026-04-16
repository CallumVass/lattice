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
  },
  "learnings": {
    "enabled": true,
    "storePath": ".lattice/learnings.jsonl"
  }
}
```

## What You Can Override

- Agent model per bundled agent
- Extra prompt suffix per agent
- Stage skip flags per pipeline
- Stage skill settings per pipeline
- Extra skill directories
- Global max number of injected skills
- Learnings capture (`learnings.enabled`, `learnings.storePath`)

## Learnings

After a `/review` run finishes posting comments, lattice writes one structured entry per posted finding to `learnings.storePath` (default `.lattice/learnings.jsonl`). The file is appended-to over time and added to `.gitignore` on the first capture.

- `learnings.enabled` (default `true`) — toggle the capture hook. When `false`, no entries are written and `/lattice-status` omits the learnings line.
- `learnings.storePath` (default `.lattice/learnings.jsonl`) — relative to the project root, or absolute.

## Notes

- The config format is JSONC, so comments are allowed.
- Config merging is shallow by top-level section, with project values winning.
