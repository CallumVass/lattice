# Lattice

Lattice is an [OpenCode](https://opencode.ai) plugin for running repeatable multi-agent workflows.

It ships with three built-in pipelines:

- `architecture`: architecture review
- `implement`: plan -> architecture review -> implement -> refactor -> code review -> review judge
- `review`: code review -> review judge

Lattice handles stage orchestration, session reuse vs cold starts, skill injection, and persisted pipeline state in `.lattice/`.

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

## First Use

Run one of these inside OpenCode:

- `/implement fix the login redirect`
- `/architecture identify the biggest architectural risks`
- `/review audit the new billing changes`
- `/lattice-status`

## Docs

- `docs/what-lattice-does.md`: repo overview and core concepts
- `docs/install.md`: setup and plugin registration
- `docs/run-a-pipeline.md`: how to use built-in commands
- `docs/custom-pipelines.md`: add your own pipeline
- `docs/configuration.md`: override agents, stages, and skill paths
- `docs/skills.md`: how skill discovery and selection works
- `docs/state-and-completion.md`: `.lattice/` files, stage completion, retry behavior

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
