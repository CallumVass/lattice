# AGENTS

## Documentation

After adding a new feature, update the relevant documentation before finishing the task.

This includes `README.md` and files under `docs/` when the feature changes setup, usage, behavior, configuration, or onboarding.

## Verification

Before finishing code changes, run `npm run check` rather than individual verification commands. It must cover typechecking, Biome, Knip, and tests. Do not use commands like `npx biome`, `npm test`, `npx vitest`, or `npm run lint` as a substitute.
