# Lattice

Lattice is an [OpenCode](https://opencode.ai) plugin for running repeatable multi-agent pipelines.

It is a framework — not a product with built-in pipelines. You supply the agents, skills, and pipeline definitions; Lattice handles stage orchestration, session reuse vs cold starts, skill injection, and persisted pipeline state in `.lattice/`.

## Install

Register the npm package directly in `opencode.json`. OpenCode will download it:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

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

These three come from Lattice itself, independent of your pipelines:

- `/lattice-status` — show current pipeline state
- `/lattice-abort` — stop the active pipeline
- `/lattice-retry [response]` — resume a paused pipeline, optionally with a reply to the pause reason

## First Use

1. Author a pipeline file and drop it in one of the pipeline paths above.
2. Make sure every agent it references exists under `agents/`, and every pinned skill exists under `skills/`.
3. Inside OpenCode, run `/<your-pipeline-name> <goal>`.
4. Use `/lattice-status` to watch it progress.

## Docs

- `docs/what-lattice-does.md`: overview and core concepts
- `docs/install.md`: setup and plugin registration
- `docs/run-a-pipeline.md`: running a pipeline, pauses, retries
- `docs/custom-pipelines.md`: authoring a pipeline
- `docs/configuration.md`: overriding agents, stages, and skill paths
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
