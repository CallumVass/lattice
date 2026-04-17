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
    "storePath": ".lattice/learnings.jsonl",
    "agents": ["code-reviewer"],
    "maxPerAgent": 5,
    "confidenceThreshold": 0.5
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
- Learnings capture + injection (`learnings.enabled`, `learnings.storePath`, `learnings.agents`, `learnings.maxPerAgent`, `learnings.confidenceThreshold`)

## Learnings

After a `/review` run finishes posting comments, lattice writes one structured entry per posted finding to `learnings.storePath` (default `.lattice/learnings.jsonl`). The file is appended-to over time and added to `.gitignore` on the first capture.

On subsequent runs the reviewer sees a synthetic `codebase-learnings` skill injected alongside normal skills, holding the top-ranked entries for that agent. It cites them back in new findings as `(learning: <id>)` so recurrences are tagged.

Per-run aggregate stats (findings count, by-category breakdown, learnings injected) land in `.lattice/metrics.jsonl`. `/lattice-status` surfaces the trailing 5-run findings average so you can watch the loop trend down per category.

- `learnings.enabled` (default `true`) — toggle capture AND injection. When `false`, no entries are written, no learnings skill is injected, and `/lattice-status` omits the learnings line.
- `learnings.storePath` (default `.lattice/learnings.jsonl`) — relative to the project root, or absolute.
- `learnings.agents` (default `["code-reviewer"]`) — which agents receive the synthetic learnings skill. Use `"*"` as an entry to cover every agent.
- `learnings.maxPerAgent` (default `5`) — cap on entries rendered into the synthetic skill.
- `learnings.confidenceThreshold` (default `0.5`) — entries below this are dropped before ranking.

## Notes

- The config format is JSONC, so comments are allowed.
- Config merging is shallow by top-level section, with project values winning.
