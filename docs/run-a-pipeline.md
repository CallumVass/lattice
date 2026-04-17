# Run A Pipeline

## Built-in Commands

- `/implement <goal>`: full delivery pipeline
- `/architecture <goal>`: architecture exploration pipeline
- `/review <PR URL or number>`: read-only PR review — reviews the target PR, validates findings, runs an advisory architecture + refactor pass, proposes PR comments, pauses for your approval, then posts the survivors as inline PR comments
- `/review-lite <PR URL or number>`: same as `/review` without the advisory pass — strict blocking-only findings
- `/investigate <goal>`: research a topic and write a spike/RFC
- `/create-jira-issues <goal>`: draft and create Jira issues (needs the Atlassian MCP)
- `/lattice-status`: show current pipeline status
- `/lattice-abort`: stop the active pipeline
- `/lattice-retry`: resume a paused pipeline. At the `/review` approval gate accepts `kill:[ids]` to drop specific findings before posting (see "Dropping a finding" below)
- `/lattice-learning-feedback <id> valid|invalid|stale`: adjust a single captured learning
- `/lattice-insights`: print a markdown report of the learning-loop trend, top reinforced patterns, near-expiry entries, and negative count. Optional `since:YYYY-MM-DD` narrows the trend window

The goal can be free text, an issue number, or a URL.

## What `/architecture` Does

```text
architecture-review
```

The architecture reviewer explores the repo, ranks architectural friction, and finishes by calling `lattice_signal`.

## What `/implement` Does

```text
plan -> arch-review -> implement -> refactor -> review-loop (code-review -> review-judge)
```

- `plan` writes `.lattice/plans/<goal-slug>.md`
- `implement` completes when every checklist item in that plan is checked
- The final stage is `review-loop`, an internal review pipeline where a `reject` from the judge pauses the run so the implementor can retry. This is different from the standalone `/review` — see below.

### Known codebase risks in the plan

If `.lattice/learnings.jsonl` has entries captured from prior reviews (see "Learnings capture" below), the planner scans them before drafting and adds a `## Known Codebase Risks` section to the plan — one line per relevant entry in the form `- (learning: <id>) <pattern>`. Tasks that intentionally pre-empt one of those patterns cite the id inline, e.g. `1. Add null guard on user.email (learning: a1b2c3d4).`

The section is conditional: if no captured learnings are relevant to the goal, the planner omits it entirely rather than writing an empty heading.

## What `/review` Does

```text
code-review -> review-judge -> advisory-review -> propose-comments (user approves) -> post-comments
```

The standalone `/review` is a read-only PR review. It never attempts fixes and never halts on blocking findings:

- `code-review` walks a structured checklist and signals `complete` with its FINDINGS report.
- `review-judge` (the `pr-review-judge` agent) validates each finding against the real code, drops anything it cannot verify, and signals `complete` with the survivors.
- `advisory-review` (the `architecture-reviewer` agent) runs an additive pass over the same diff looking for architectural friction and refactor opportunities — advisory only, not blocking.
- `propose-comments` (the `pr-review-composer` agent) merges the blocking survivors with the advisory notes, numbers every finding 1-indexed across both sections, writes the proposed PR comment set to `.lattice/plans/`, and pauses the pipeline. Review the proposal, then run `/lattice-retry` to post — reply with any tweaks first and they'll be passed through. Run `/lattice-retry kill:[2,4]` to drop findings 2 and 4 before posting; the dropped ones are saved as `severity: "negative"` learnings so the reviewer stops flagging that exact pattern next time.
- `post-comments` (the `pr-commenter` agent) posts each approved comment as an inline PR review comment via `gh api`. Comments without a file/line fall back to a general PR comment.

Pass a PR URL or PR number as the goal, e.g. `/review 472` or `/review https://github.com/OWNER/REPO/pull/472`. The pipeline needs `gh` authenticated for the target repo.

If you want review feedback that blocks an implementor loop (instead of posting comments), that happens automatically inside `/implement` via the internal `review-loop` pipeline — you do not invoke it directly.

### Learnings capture

Once `post-comments` finishes successfully, lattice extracts each posted finding into `.lattice/learnings.jsonl` — one JSON entry per finding (severity, file/line, derived category, source PR, timestamp). The store grows over time and is auto-added to `.gitignore` on the first capture so it stays local. `/lattice-status` reports the current count and the last-captured timestamp.

Blocking and advisory entries are tagged `agent: "*"` so downstream consumers — the code-reviewer and the `/implement` planner — both see them. On subsequent runs, the planner cites relevant entries in a `## Known Codebase Risks` section of the plan, and `/lattice-status` shows trailing-average findings-per-run split by pipeline (e.g. `Findings (review, last 5): 1.8 per run`, `Findings (implement, last 5): 0.2 per run`).

Capture is best-effort: a malformed finding or write error logs a warning but never fails the pipeline or the comments that were already posted. Disable it with `learnings.enabled: false` in `.lattice/config.jsonc` (see [configuration](configuration.md)).

### Dropping a finding at the approval gate

When `/review` pauses after `propose-comments`, you can reply:

- `/lattice-retry` — post every finding as-is (default).
- `/lattice-retry kill:[2,4]` — drop findings 2 and 4 (1-indexed across blocking + advisory). The poster only sees survivors; dropped findings are written as `severity: "negative"` learnings scoped to the reviewer, so the same false positive won't recur on the next PR.

### Per-finding feedback

Every injected learning carries an 8-char id like `(learning: a1b2c3d4)`. Use `/lattice-learning-feedback a1b2c3d4 valid|invalid|stale` to:

- `valid` — reinforce the entry (future runs lean on it more heavily).
- `invalid` — drop its confidence and feedbackScore sharply; it stays in the store but ranks below untouched entries.
- `stale` — expire it immediately so the selector stops injecting it.

### Compaction on pipeline start

Every pipeline start (not just `/review`) runs a cheap dedup pass over `.lattice/learnings.jsonl`: entries in the same category and severity whose patterns overlap enough get merged into one reinforced row. When anything merged, `/lattice-status` shows `Learnings: N entries … (M merged on last compaction)` so you can see the loop catching its own duplicates.

## What `/review-lite` Does

```text
code-review -> review-judge -> propose-comments (user approves) -> post-comments
```

Same as `/review`, minus the `advisory-review` stage. Use it when you only want the checklist-driven blocking findings and none of the softer architectural/refactor notes.

## What `/investigate` Does

```text
investigate
```

One stage. The investigator asks for a topic, an optional Confluence template URL, and optional reference URLs. It fetches references via the Atlassian MCP, explores the codebase, and writes a spike/RFC markdown file in the project root.

If the Atlassian MCP is not configured, the investigator will offer to proceed without references instead of silently skipping them.

## What `/create-jira-issues` Does

```text
draft -> create
```

Stage `draft` gathers inputs, fetches Confluence docs and an example ticket via the Atlassian MCP, explores the codebase, writes drafts to `.lattice/plans/<goal-slug>.md`, and asks for approval in chat. It signals `complete` on approval or `blocked` on cancellation. When the learning loop has stored entries relevant to a drafted ticket, the agent appends a `## Non-Functional Requirements` section citing the short learning ids — see [`learnings.md`](learnings.md) for the full flow.

Stage `create` forks from `draft`, reads the approved plan, creates the epic (if drafted) and each issue via the Atlassian MCP, and runs a single repair attempt per draft if Jira rejects it. It finishes with a summary of created keys and any failures.

**Dependency**: the [Atlassian MCP](https://github.com/sooperset/mcp-atlassian) must be configured in OpenCode for Confluence fetching and Jira creation. Without it the pipeline blocks with guidance.

## Cold Start Vs Fork

- Cold stage: starts fresh to avoid inheriting earlier reasoning
- Forked stage: keeps earlier context to avoid re-reading the repo

In the built-in pipelines, implementation-oriented stages mostly fork, while review and architecture start cold.

## When A Pipeline Pauses

If a stage returns `reject` or `blocked`, the pipeline pauses.

Use:

- `/lattice-retry` to send the run back to the nearest `implementor` stage, or retry the rejected stage when none exists
- `/lattice-abort` to stop it
