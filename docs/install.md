# Install

## Install From npm

Register the npm package directly in your project's `opencode.json`:

```json
{
  "plugin": ["@callumvass/lattice"]
}
```

OpenCode supports npm package extensions, so it will download the package automatically.

## Minimum Versions

Lattice requires an OpenCode host with the `@opencode-ai/plugin` API at `>=1.4.0`.

## Bring Your Own Content

Lattice ships no agents, skills, or pipelines — you author them. Lattice discovers your content from the following paths:

- **Pipelines**: `~/.config/opencode/lattice-pipelines/*.{ts,js,mjs}` (global) and `.opencode/lattice-pipelines/*.{ts,js,mjs}` (project, overrides global with the same name)
- **Agents**: OpenCode-native, `~/.config/opencode/agents/*.md` or `.opencode/agents/*.md`
- **Skills**: OpenCode-native, `~/.config/opencode/skills/<name>/SKILL.md` or `.opencode/skills/<name>/SKILL.md`

## Pipeline imports

Pipeline files that use the typed builder (`import { pipeline, stage } from "@callumvass/lattice/builder"`) need two things wired up where the pipeline files live:

1. **The package installed** so Node (and your editor) can resolve the import:

   ```bash
   # For ~/.config/opencode/lattice-pipelines/*.ts:
   cd ~/.config/opencode
   npm install @callumvass/lattice

   # For <project>/.opencode/lattice-pipelines/*.ts:
   cd <project>
   npm install --save-dev @callumvass/lattice
   ```

2. **A `tsconfig.json`** covering the pipeline files so the editor's TypeScript server uses proper module resolution. A minimal one at the pipeline root works:

   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "ESNext",
       "moduleResolution": "bundler",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "noEmit": true
     },
     "include": ["lattice-pipelines/**/*.ts"]
   }
   ```

   Drop it next to the `lattice-pipelines/` folder (i.e. `~/.config/opencode/tsconfig.json` for global pipelines, or rely on your project's existing tsconfig for `.opencode/lattice-pipelines/`).

Without the install you'll hit `Cannot find module '@callumvass/lattice'` at both editor and runtime for typed-builder pipelines. Without the tsconfig you'll hit the same editor error even when the package is present — the TS server can't figure out how to resolve without a project config.

Alternatively, use the plain-object form (no import, no install, no tsconfig — see [`custom-pipelines.md`](custom-pipelines.md#plain-object-api-no-install)).

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

Inside OpenCode, the `/lattice` framework command should exist. Use `/lattice status` to verify the plugin is active and `/lattice doctor` to inspect pipeline loading diagnostics.

Any pipeline you drop into the discovery paths also appears as a slash command with its pipeline `name`.

If a pipeline command is missing, run `/lattice doctor` first. It prints the pipeline search paths and any import/schema errors for skipped files.

If you change Lattice itself, rebuild with `npm run build`.
