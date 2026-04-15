# Install

## Install From npm

Register the npm package directly in your project's `opencode.json`:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

OpenCode supports npm package extensions, so it will download the package automatically.

## Build From Source

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice
npm install
npm run build
```

## Register The Plugin Globally

This makes Lattice available in every OpenCode project.

```bash
mkdir -p ~/.config/opencode/plugins
ln -s ~/dev/lattice/dist/plugin/index.js ~/.config/opencode/plugins/lattice.js
```

## Register The Plugin Per Project

Add this to your project's `opencode.json`. This example assumes you vendored the repo at `.lattice/lattice`:

```json
{
  "plugin": ["./.lattice/lattice/dist/plugin/index.js"]
}
```

Use an absolute path or a path starting with `.`.

## Verify It Loaded

Inside OpenCode, these commands should exist:

- `/implement`
- `/architecture`
- `/review`
- `/lattice-status`
- `/lattice-abort`
- `/lattice-retry`

If you change Lattice itself, rebuild with `npm run build`.
