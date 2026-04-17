# Learning Loop

Lattice turns every reviewed finding into a persistent, decayed, per-repo training example — blocking findings, advisory notes, and false positives the user rejects at the approval gate. Each downstream pipeline (`/review`, `/implement`, `/create-jira-issues`) consults the store before it runs so recurring patterns are cited, known risks are pre-empted in plans, and non-functional requirements flow into drafted Jira tickets.

The subsystem lives in `src/learnings/` and is disabled by a single switch (`learnings.enabled: false`) in `.lattice/config.jsonc`.

## Lifecycle

```
/review run → composer prepares FINDINGS → user approves / kills entries
       ↓
extractor → reinforce-or-append → .lattice/learnings.jsonl
       ↓
next /review | /implement | /create-jira-issues start
       ↓
compaction pass → selector ranks → renderLearningsAsSkill
       ↓
system-transform injects `codebase-learnings` synthetic skill
       ↓
agents cite `(learning: <id>)` → findings trend down over time
```

## Capture

`captureLearningsFromReview` fires when the `/review` pipeline's `post-comments` stage finishes successfully. The composer's pre-approval FINDINGS summary is parsed by `extractor.ts` into structured `LearningEntry` rows:

- **blocking** and **advisory** entries default to `agent: "*"` so the planner, reviewer, and jira-drafter all see them.
- **negative** entries (findings the user killed via `/lattice-retry kill:[...]`) are scoped to `code-reviewer` — they teach the reviewer what NOT to flag but never reach planner or jira-drafter.

Each captured entry is matched against the existing store (`compaction.findReinforcementTarget`) using category + file hint + token-Jaccard similarity; a match reinforces the existing row instead of appending a duplicate. The store file is auto-added to `.gitignore` on first capture.

## Injection

`src/plugin/stage-runner.ts` builds a synthetic `codebase-learnings` skill for every stage whose agent is listed in `learnings.agents`. Selection order:

1. Filter by agent match (`"*"` or exact agent name) and non-expired.
2. Drop entries below `learnings.confidenceThreshold`.
3. If the candidate set already fits under `learnings.maxPerAgent`, return it sorted by `confidence × (1 + feedbackScore)`.
4. Otherwise delegate to the shared LLM scorer (same wire format as `scoreSkills`) so the model ranks by goal/stage relevance.

Each surviving entry is rendered as `- (learning: <short-id>) [blocking|advisory] <pattern>` and grouped by category. Agents are instructed to cite the short id back when a new finding recurs a known pattern.

### Per-agent surfaces

| Agent | How it uses the injected learnings |
| --- | --- |
| `code-reviewer` | Cites `(learning: <id>)` in findings that recur a known pattern. |
| `planner` | Adds a `## Known Codebase Risks` section to `.lattice/plans/<slug>.md`; tasks that intentionally pre-empt a pattern cite the id. |
| `jira-planner` | Appends a `## Non-Functional Requirements` section to drafted tickets citing relevant advisory/blocking ids. Skips the section when nothing applies. Never surfaces negatives as NFRs. |

## Decay

`decay.applyDecay` applies `confidence *= exp(-age_days × decayRate)` at selection time so long-idle entries fade relative to fresh ones. Signals that modify `confidence`:

- A re-occurring finding reinforces: `confidence += reinforcementBoost`, `lastSeenAt = now`, `reinforcementCount += 1`.
- `/lattice-learning-feedback <id> valid` behaves like a reinforcement plus a `+0.5` bump to `feedbackScore`.
- `/lattice-learning-feedback <id> invalid` multiplies confidence by `(1 - invalidPenalty)` and drops `feedbackScore` by `0.5`.
- `/lattice-learning-feedback <id> stale` sets `expiresAt = now` — the selector filters the entry out of every future injection.

The full feedback tool contract is in [`configuration.md`](configuration.md).

## Compaction

`compact()` runs on every pipeline start (not just `/review`). It groups entries by `(category, file-hint, severity, agent)` and merges pairs whose normalized-token Jaccard similarity meets `learnings.similarityThreshold`. Merges are lossless — the surviving row keeps the earliest `createdAt`, the latest `lastSeenAt`, the max of numeric fields, and the union of PR references. `/lattice-status` shows `(N merged on last compaction)` whenever the pass collapses duplicates.

## Metrics

`metrics.recordRun` appends one row per completed pipeline to `.lattice/metrics.jsonl`:

```jsonc
{
  "instance": "…",
  "pipeline": "review",
  "findingsCount": 3,
  "byCategory": { "auth": 2, "db": 1 },
  "learningsInjected": 4,
  "timestamp": "2026-04-17T…"
}
```

`/lattice-status` reads the last five runs to surface trailing averages both overall and split per pipeline (`review`, `implement`).

## Insights

`/lattice-insights` prints a markdown report built from the store + metrics:

- **Findings trend** — weekly count per category across the last ~8 weeks (or `since:<date>` to narrow).
- **Top 10 patterns by reinforcement** — positive entries ordered by `reinforcementCount` then `confidence`.
- **Near expiry (top 5)** — positive entries nearest the point where decay drops them below the threshold, so you can confirm / reinforce before they vanish.
- **Negative learnings** — count of user-rejected patterns currently teaching the reviewer what NOT to flag.

The tool is read-only and safe to call even while a pipeline is active.

## Configuration reference

All knobs are under the `learnings` section of `.lattice/config.jsonc`. See [`configuration.md`](configuration.md#learnings) for the full list and defaults.

## Commands summary

| Command | Action |
| --- | --- |
| `/review …` | Runs the review pipeline — capture fires on successful `post-comments`. |
| `/lattice-retry kill:[ids]` | Drops findings at the approval gate; kills become negative learnings. |
| `/lattice-learning-feedback <id> valid\|invalid\|stale` | Adjusts a single entry. |
| `/lattice-insights [since:YYYY-MM-DD]` | Prints the insights report. |
| `/lattice-status` | Shows entry count, last-capture timestamp, compaction merges, and trailing findings averages. |
