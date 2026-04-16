# Run A Pipeline

## Built-in Commands

- `/implement <goal>`: full delivery pipeline
- `/architecture <goal>`: architecture exploration pipeline
- `/review <goal>`: review-only pipeline
- `/investigate <goal>`: research a topic and write a spike/RFC
- `/create-jira-issues <goal>`: draft and create Jira issues (needs the Atlassian MCP)
- `/lattice-status`: show current pipeline status
- `/lattice-abort`: stop the active pipeline
- `/lattice-retry`: resume a paused pipeline

The goal can be free text, an issue number, or a URL.

## What `/architecture` Does

```text
architecture-review
```

The architecture reviewer explores the repo, ranks architectural friction, and finishes by calling `lattice_signal`.

## What `/implement` Does

```text
plan -> arch-review -> implement -> refactor -> code-review -> review-judge
```

- `plan` writes `.lattice/plans/<goal-slug>.md`
- `implement` completes when every checklist item in that plan is checked
- review stages finish by calling `lattice_signal`

## What `/review` Does

```text
code-review -> review-judge
```

Both review stages use `lattice_signal` to report their result.

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

Stage `draft` gathers inputs, fetches Confluence docs and an example ticket via the Atlassian MCP, explores the codebase, writes drafts to `.lattice/plans/<goal-slug>.md`, and asks for approval in chat. It signals `complete` on approval or `blocked` on cancellation.

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
