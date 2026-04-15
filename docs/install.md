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

Only do this if you are developing Lattice itself.

```bash
git clone https://github.com/CallumVass/lattice.git ~/dev/lattice
cd ~/dev/lattice
npm install
npm run build
```

## Use A Local Source Build

After building from source, point OpenCode at the built plugin file:

```json
{
  "plugin": ["~/dev/lattice/dist/plugin/index.js"]
}
```

## Verify It Loaded

Inside OpenCode, these commands should exist:

- `/implement`
- `/architecture`
- `/review`
- `/lattice-status`
- `/lattice-abort`
- `/lattice-retry`

If you change Lattice itself, rebuild with `npm run build`.
