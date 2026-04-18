# Install

## Install From npm

Register the npm package directly in your project's `opencode.json`:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

OpenCode supports npm package extensions, so it will download the package automatically.

## Bring Your Own Content

Lattice ships no agents, skills, or pipelines — you author them. Lattice discovers your content from the following paths:

- **Pipelines**: `~/.config/opencode/lattice-pipelines/*.ts` (global) and `.opencode/lattice-pipelines/*.ts` (project, overrides global with the same name)
- **Agents**: OpenCode-native, `~/.config/opencode/agents/*.md` or `.opencode/agents/*.md`
- **Skills**: OpenCode-native, `~/.config/opencode/skills/<name>/SKILL.md` or `.opencode/skills/<name>/SKILL.md`

## Pipeline imports

Pipeline files that use the typed builder (`import { pipeline, stage } from "@callumvass/lattice"`) need lattice resolvable from the pipeline file's location. Install it once where your pipelines live:

```bash
# For ~/.config/opencode/lattice-pipelines/*.ts:
cd ~/.config/opencode
npm install @callumvass/lattice

# For <project>/.opencode/lattice-pipelines/*.ts:
cd <project>
npm install --save-dev @callumvass/lattice
```

Without that install, you'll hit `Cannot find module '@callumvass/lattice'` at both editor and runtime. Alternatively, use the plain-object form (no import, no install — see [`custom-pipelines.md`](custom-pipelines.md#plain-object-api)).

See [`custom-pipelines.md`](custom-pipelines.md) for authoring pipelines, [`skills.md`](skills.md) for skill discovery, and the OpenCode docs for agents/skills format.

## Build From Source

Only do this if you are developing Lattice itself.

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice
npm install
npm run build
```

After building from source, point OpenCode at the built plugin file:

```json
{
  "plugin": ["~/dev/lattice/dist/plugin/index.js"]
}
```

## Verify It Loaded

Inside OpenCode, these framework commands should exist:

- `/lattice-status`
- `/lattice-abort`
- `/lattice-retry`

Any pipeline you drop into the discovery paths also appears as a slash command with its pipeline `name`.

If you change Lattice itself, rebuild with `npm run build`.
