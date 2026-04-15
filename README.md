# Lattice

Composable agentic pipelines for [OpenCode](https://opencode.ai). Specialized agents plan, implement, refactor, and review code through multi-stage workflows with fork-aware sessions, dynamic skill loading, and structured signaling.

## Quick Start

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice && npm install && npm run build
```

Register globally (works in every project):

```bash
mkdir -p ~/.config/opencode/plugins
ln -s ~/dev/lattice/dist/plugin/index.js ~/.config/opencode/plugins/lattice.js
```

Or per-project in `opencode.json` (paths must be absolute or start with `.`):

```json
{ "plugin": ["./.lattice/lattice/dist/plugin/index.js"] }
```

That's it. The plugin auto-registers all agents, skills, pipelines, commands, and tools — no file copying.

## Commands

| Command | Description |
|---|---|
| `/implement <goal>` | Full TDD pipeline: plan, arch-review, implement, refactor, review |
| `/review <goal>` | Adversarial code review: code-review, review-judge |
| `/lattice-status` | Show active pipeline and stage progress |
| `/lattice-abort` | Cancel the active pipeline |
| `/lattice-retry` | Resume a paused pipeline (loops back to implementor) |

The goal can be free text, a GitHub issue number, or a URL.

## Builtin Pipelines

**implement**
```
plan (cold) → arch-review (fork) → implement (fork) → refactor (fork) → code-review (cold) → review-judge (fork)
```

**review**
```
code-review (cold) → review-judge (fork)
```

- **cold** = fresh session. Adversarial independence — the agent evaluates code without inheriting prior reasoning.
- **fork** = inherits the previous session's context. Saves cost by not re-reading files.

## Agents

| Agent | Role | Can write? |
|---|---|---|
| `planner` | Reads issue, explores codebase, outputs sequenced test plan | No |
| `architecture-reviewer` | Critiques plan against existing codebase patterns | No |
| `implementor` | TDD red-green-refactor through the plan | Yes |
| `refactorer` | Post-implementation cleanup — extract patterns, remove duplication | Yes |
| `code-reviewer` | Checklist-driven review (Logic, Security, Error Handling, Performance, Tests) | No |
| `review-judge` | Validates reviewer findings against actual code, filters noise | No |

All agents are registered via the config hook with system prompts and permissions. Override any agent in your `opencode.json`:

```json
{
  "agent": {
    "implementor": { "model": "anthropic/claude-sonnet-4-20250514" }
  }
}
```

## Builtin Skills

| Skill | Used by | Description |
|---|---|---|
| `tdd` | implementor | Boundary testing, red-green-refactor workflow, mocking guidelines |
| `code-review` | code-reviewer | Review checklist, evidence requirements, confidence scoring, anti-patterns |
| `opensrc` | planner, implementor | Fetch library source code for any language via `npx opensrc` |

Skills are injected into agent system prompts automatically based on stage config.

## Custom Pipelines

Create `.lattice/pipelines/<name>.ts` in your project. User pipelines are auto-discovered and override builtins with the same name. The filename doesn't matter — the `name` field determines the command.

**With builder API** (requires `@lattice/opencode` resolvable):

```typescript
import { pipeline, stage, ref } from "@lattice/opencode";

export default pipeline("quick-fix", {
  stages: [
    stage("implement", { agent: "implementor", completion: "plan_complete", fork: false }),
    ref("review"), // inlines the review pipeline's stages
  ],
});
```

**Without any dependency** (plain objects validated by Zod):

```typescript
export default {
  name: "quick-fix",
  stages: [
    { id: "implement", type: "stage", agent: "implementor", completion: "plan_complete", fork: false },
    { type: "pipeline", pipeline: "review" },
  ],
};
```

The command `/quick-fix <goal>` is registered automatically.

### Pipeline Composition

Pipelines reference other pipelines via `ref("name")` or `{ type: "pipeline", pipeline: "name" }`. At runtime, referenced stages are inlined — no nesting overhead. Circular references are detected and rejected.

### Stage Options

```typescript
stage("my-stage", {
  agent: "agent-name",         // required — which opencode agent runs this stage
  completion: "idle",          // required — how the engine knows the stage is done
  fork: true,                  // optional — fork from previous session (default: false)
  skills: {                    // optional — skill loading for this stage
    dynamic: true,             // LLM-assisted skill selection
    pinned: ["tdd"],           // always-loaded skills
    max: 4,                    // max skills to inject
  },
  prompt: "Custom instructions for {{goal}}", // optional — appended to composed prompt
})
```

### Completion Methods

| Method | Trigger | Use when |
|---|---|---|
| `idle` | Session goes idle | Agent just needs to finish its work (refactorer, arch-reviewer) |
| `plan_created` | `.lattice/plans/<slug>.md` exists | Planner writes a plan file |
| `plan_complete` | All `- [x]` checkboxes checked | Implementor works through a plan |
| `tool_signal` | Agent calls `lattice_signal` tool | Agent needs to report a verdict (approve/reject/blocked) |

### The `lattice_signal` Tool

Registered automatically by the plugin. Agents call it to report structured outcomes:

```
lattice_signal(status: "complete")                     // stage done
lattice_signal(status: "approve")                      // review passed
lattice_signal(status: "reject", reason: "2 issues")   // review failed → pipeline pauses
lattice_signal(status: "blocked", reason: "...")        // pipeline pauses
```

When a pipeline pauses, use `/lattice-retry` to loop back to the implementor, or `/lattice-abort` to cancel.

## Configuration

Create `.lattice/config.jsonc` (project-level) or `~/.config/lattice/config.jsonc` (global). Project overrides global.

```jsonc
{
  // Override agent models or inject extra instructions
  "agents": {
    "implementor": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "promptSuffix": "Always use vitest. Never mock the database."
    }
  },

  // Skip or customize pipeline stages
  "pipelines": {
    "implement": {
      "stages": {
        "arch-review": { "skip": true },
        "plan": { "skills": { "pinned": ["tdd", "nextjs"] } }
      }
    }
  },

  // Extra skill directories and limits
  "skills": {
    "paths": ["/path/to/extra/skills"],
    "max": 4
  }
}
```

## Skills

### How skill loading works

1. **Scan** — discovers `.md` files from `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` (project + global), extra config paths, and bundled skills
2. **Select** — for stages with `dynamic: true`, an LLM scores skill relevance against the task context and selects the top-N
3. **Inject** — selected skill content is added to the agent's system prompt via `experimental.chat.system.transform`

Pinned skills always load. Dynamic fills remaining slots. Project skills override global; global overrides bundled.

### Adding custom skills

Drop a `.md` file in `.opencode/skills/` (or any scanned directory):

```markdown
---
name: my-framework
description: Patterns and conventions for My Framework
---

# My Framework Skill

Instructions the agent should follow...
```

The `name` and `description` frontmatter are used for LLM-assisted selection. Skills without frontmatter use the filename as the name.

## How It Works

1. User runs `/implement fix the login bug`
2. Plugin intercepts the command, cleans up prior signals, starts the pipeline
3. Engine creates a `PipelineInstance` with stages from the flattened pipeline definition
4. For each stage: creates or forks a session, composes a prompt (goal + completed stage summaries + stage instructions), sends it via the SDK
5. On `session.idle` events, engine checks completion (file exists? checkboxes done? signal file written?)
6. If complete, marks stage done, advances to next. If rejected/blocked, pauses and toasts the user
7. State persists to `.lattice/state/` — survives opencode restarts
8. On pipeline completion, cleans up signal files

### Fork model

Each stage declares `fork: true` or `fork: false`:
- `fork: true` — forks the previous stage's session via the SDK. The agent inherits conversation history (file reads, tool results). No redundant codebase exploration.
- `fork: false` — creates a fresh session. Used for adversarial stages like code review where inherited reasoning would bias the evaluation.

### Directory structure (created at runtime)

```
.lattice/
├── state/         Pipeline instance state (JSON)
├── plans/         Plan files written by the planner
└── signals/       Signal files written by lattice_signal tool
```

## Development

```bash
npm install
npm run check      # typecheck + lint + knip + test (67 tests)
npm run build      # tsup → dist/
```

After changes, `npm run build` updates the dist — the symlink picks it up automatically.

## License

MIT
