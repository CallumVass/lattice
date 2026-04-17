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
    "agents": ["code-reviewer", "planner"],
    "maxPerAgent": 5,
    "confidenceThreshold": 0.5,
    "decayRate": 0.05,
    "reinforcementBoost": 0.15,
    "invalidPenalty": 0.4,
    "similarityThreshold": 0.7
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

On subsequent runs the reviewer sees a synthetic `codebase-learnings` skill injected alongside normal skills, holding the top-ranked entries for that agent. It cites them back in new findings as `(learning: <id>)` so recurrences are tagged. The `/implement` planner also sees the skill and adds a `## Known Codebase Risks` section to the plan when any captured entries apply to the goal.

Per-run aggregate stats (findings count, by-category breakdown, learnings injected) land in `.lattice/metrics.jsonl`. `/lattice-status` surfaces the trailing 5-run findings average overall and split per pipeline (review, implement) so you can watch the loop trend down per category and see whether the planner's pre-emption is keeping findings out of implement runs.

- `learnings.enabled` (default `true`) — toggle capture AND injection. When `false`, no entries are written, no learnings skill is injected, and `/lattice-status` omits the learnings line.
- `learnings.storePath` (default `.lattice/learnings.jsonl`) — relative to the project root, or absolute.
- `learnings.agents` (default `["code-reviewer", "planner"]`) — which agents receive the synthetic learnings skill. Use `"*"` as an entry to cover every agent.
- `learnings.maxPerAgent` (default `5`) — cap on entries rendered into the synthetic skill.
- `learnings.confidenceThreshold` (default `0.5`) — entries below this are dropped before ranking.
- `learnings.decayRate` (default `0.05`, per day) — age-based exponential decay applied to confidence; higher values make stale entries fall out of ranking faster.
- `learnings.reinforcementBoost` (default `0.15`) — confidence added each time an entry is re-seen on a new run or marked `valid` via `/lattice-learning-feedback` (capped at 1.0).
- `learnings.invalidPenalty` (default `0.4`) — multiplicative confidence drop applied on an `invalid` feedback verdict; `feedbackScore` also drops by 0.5.
- `learnings.similarityThreshold` (default `0.7`) — Jaccard threshold used to merge near-duplicate entries on pipeline start and to decide whether a fresh finding reinforces an existing one instead of creating a duplicate.

### Feedback verdicts

`/lattice-learning-feedback <id> valid|invalid|stale` adjusts a single entry:

- `valid` → confidence boosted by `reinforcementBoost`, `feedbackScore` bumped toward `+1`.
- `invalid` → confidence dropped by `invalidPenalty`, `feedbackScore` bumped toward `-1`; the entry stays in the store but ranks lower.
- `stale` → `expiresAt` set to now; the selector filters it out of every future injection.

The id can be the full uuid or the 8-char short id shown inline in the synthetic `codebase-learnings` skill (e.g. `a1b2c3d4`).

## Notes

- The config format is JSONC, so comments are allowed.
- Config merging is shallow by top-level section, with project values winning.
