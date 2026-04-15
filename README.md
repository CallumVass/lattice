# Lattice

Lattice is an [OpenCode](https://opencode.ai) plugin for running repeatable multi-agent workflows.

It ships with three built-in pipelines:

- `architecture`: architecture review
- `implement`: plan -> architecture review -> implement -> refactor -> code review -> review judge
- `review`: code review -> review judge

Lattice handles stage orchestration, session reuse vs cold starts, skill injection, and persisted pipeline state in `.lattice/`.

## Install

Install from npm in the project where you use OpenCode:

```bash
npm install @callumvass/lattice
```

Then register the plugin in `opencode.json`:

```json
{
  "plugin": ["./node_modules/@callumvass/lattice/dist/plugin/index.js"]
}
```

Or build from source:

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice
npm install
npm run build
```

Register the plugin globally:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s ~/dev/lattice/dist/plugin/index.js ~/.config/opencode/plugins/lattice.js
```

Or register it per project. Example if you vendor this repo under `.lattice/lattice`:

```json
{
  "plugin": ["./.lattice/lattice/dist/plugin/index.js"]
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

Releases use `release-please` on `main`. Conventional commits drive the release PR; merge that PR and CI publishes to npm via trusted publishing.

GitHub setup:

- `RELEASE_PLEASE_TOKEN`: PAT used by release-please so release PRs trigger CI
- npm trusted publishing for this GitHub repo/package pair

## License

MIT
