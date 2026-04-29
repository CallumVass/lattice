# Lattice

Lattice is an [OpenCode](https://opencode.ai) plugin for running repeatable multi-agent pipelines.

It is a framework — not a product with built-in pipelines. You supply the agents, skills, and pipeline definitions; Lattice handles stage orchestration, dynamic stage expansion, session reuse vs cold starts, skill injection, and persisted pipeline state in `.lattice/`.

## Install

Register the npm package directly in `opencode.json`. OpenCode will download it:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

Lattice requires an OpenCode host with the `@opencode-ai/plugin` API at `>=1.4.0`, which provides the native permission prompt API used for sensitive `/lattice` actions.

If you are developing Lattice itself, build from source:

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice
npm install
npm run build
```

Then point OpenCode at the built plugin file:

```json
{
  "plugin": ["~/dev/lattice/dist/plugin/index.js"]
}
```

## Bring Your Own Content

Lattice discovers content from OpenCode's conventional paths. Project paths override global ones with the same name.

| Content | Project path | Global path |
| --- | --- | --- |
| Pipelines | `.opencode/lattice-pipelines/*.ts` | `~/.config/opencode/lattice-pipelines/*.ts` |
| Agents | `.opencode/agents/*.md` | `~/.config/opencode/agents/*.md` |
| Skills | `.opencode/skills/<name>/SKILL.md` | `~/.config/opencode/skills/<name>/SKILL.md` |

A pipeline file has a default export — either the typed builder (`import { pipeline, stage } from "@callumvass/lattice"`) or a plain object. A pipeline named `my-flow` registers `/my-flow <goal>` as a slash command automatically. See [`docs/custom-pipelines.md`](docs/custom-pipelines.md).

**If you use the typed builder**, install `@callumvass/lattice` where your pipelines live so they can resolve the import:

```bash
cd ~/.config/opencode && npm install @callumvass/lattice   # for global pipelines
cd <your-project> && npm install --save-dev @callumvass/lattice   # for project pipelines
```

## Framework Commands

Lattice exposes one framework command, independent of your pipelines:

- `/lattice status` — show current pipeline state
- `/lattice run <pipeline> <goal>` — start a pipeline by name
- `/lattice continue [response]` — resume a pipeline paused at a `pauseAfter` checkpoint
- `/lattice retry [response]` — retry a failed or blocked stage, rewinding to the nearest `isRewindTarget` when configured
- `/lattice accept [reason]` — accept a failed or blocked stage and advance past it
- `/lattice abort` — stop the active pipeline
- `/lattice reset` — recover a pipeline stuck in `running` state; marks the stuck stage pending and pauses the pipeline so retry can restart it

## First Use

1. Author a pipeline file and drop it in one of the pipeline paths above.
2. Make sure every agent it references exists under `agents/`, and every pinned skill exists under `skills/`.
3. Inside OpenCode, run `/<your-pipeline-name> <goal>`.
4. Use `/lattice status` to watch it progress.

## Docs

- `docs/what-lattice-does.md`: overview and core concepts
- `docs/install.md`: setup and plugin registration
- `docs/run-a-pipeline.md`: running a pipeline, pauses, retries
- `docs/custom-pipelines.md`: authoring a pipeline, including dynamic stage expansion
- `docs/configuration.md`: overriding agents, stages, skill paths, and model selection
- `docs/skills.md`: skill discovery and selection
- `docs/state-and-completion.md`: `.lattice/` files, completion methods, retry behavior

## Development

```bash
npm run check
npm run build
npm run release:check
```

Releases use `release-please` on `main`. Conventional commits drive the release PR; rebase-merge that PR and CI publishes to npm via trusted publishing.

GitHub setup:

- `RELEASE_PLEASE_TOKEN`: PAT used by release-please so release PRs trigger CI
- npm trusted publishing for this GitHub repo/package pair

## License

MIT
