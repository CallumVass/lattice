# Changelog

## [1.3.0](https://github.com/CallumVass/lattice/compare/lattice-v1.2.0...lattice-v1.3.0) (2026-04-17)


### Features

* **learnings:** inject learnings into code-reviewer prompt ([a4725da](https://github.com/CallumVass/lattice/commit/a4725da2d05760f7e1247b3685a24d46a7d177ac))

## [1.2.0](https://github.com/CallumVass/lattice/compare/lattice-v1.1.0...lattice-v1.2.0) (2026-04-17)


### Features

* **implement:** surface plan and arch critique at gate pauses ([aa2a151](https://github.com/CallumVass/lattice/commit/aa2a151947800c51a858db4e8daafa51475af0ea))
* **review:** show proposed comments on pause and post in teammate voice ([b5583be](https://github.com/CallumVass/lattice/commit/b5583be485f7e574e4dc60235ccb09ac458615de))

## [1.1.0](https://github.com/CallumVass/lattice/compare/lattice-v1.0.0...lattice-v1.1.0) (2026-04-17)


### Features

* **learnings:** capture structured findings from review pipeline ([7066fc8](https://github.com/CallumVass/lattice/commit/7066fc819a117bd9ca3523be739669f5366ab6d0))

## [1.0.0](https://github.com/CallumVass/lattice/compare/lattice-v0.6.0...lattice-v1.0.0) (2026-04-16)


### ⚠ BREAKING CHANGES

* internal engine functions (advancePipeline, startPipeline, buildStageAction, markStageRunning, checkStageCompletion, checkCompletion, composePrompt, findActiveInstance, loadInstance, saveInstance, flattenPipeline, loadPipelines) are no longer exported from the package root. Custom pipelines only need pipeline/stage/ref + schema types, which remain exported.

### Code Refactoring

* route plugin imports through engine facade and shrink public api ([e75e9f1](https://github.com/CallumVass/lattice/commit/e75e9f18a947fa35f3def9b34178aae8726e6982))

## [0.6.0](https://github.com/CallumVass/lattice/compare/lattice-v0.5.0...lattice-v0.6.0) (2026-04-16)


### Features

* **review:** add advisory pass and approval gate before posting comments ([263c78a](https://github.com/CallumVass/lattice/commit/263c78a6a0268fba2ef44e3a5d351a0dafe95742))

## [0.5.0](https://github.com/CallumVass/lattice/compare/lattice-v0.4.1...lattice-v0.5.0) (2026-04-16)


### Features

* approval gates and user responses on retry ([fc1e96b](https://github.com/CallumVass/lattice/commit/fc1e96bee03cfdbdaa44cf6d90c441df62f6240b))


### Bug Fixes

* resolve agents/ dir correctly after bundling ([bb72bea](https://github.com/CallumVass/lattice/commit/bb72bea796b77d3410c21b3ad3b3bc9f70efdd8d))
* **review:** resolve diff from PR number, URL, or branch ([930d857](https://github.com/CallumVass/lattice/commit/930d857761422d1352d8ad2ea8873a76264a4349))

## [0.4.1](https://github.com/CallumVass/lattice/compare/lattice-v0.4.0...lattice-v0.4.1) (2026-04-16)


### Bug Fixes

* let planner write its plan file ([6de741c](https://github.com/CallumVass/lattice/commit/6de741c18b57bef1d01e598963d770175e72dbd5))

## [0.4.0](https://github.com/CallumVass/lattice/compare/lattice-v0.3.1...lattice-v0.4.0) (2026-04-16)


### Features

* standalone /review posts PR comments, gate tools behind confirm ([0b98181](https://github.com/CallumVass/lattice/commit/0b98181c97d3a44ae79231cdfe500410cdc95d20))

## [0.3.1](https://github.com/CallumVass/lattice/compare/lattice-v0.3.0...lattice-v0.3.1) (2026-04-16)


### Bug Fixes

* restore default plugin export from package root ([f081f9e](https://github.com/CallumVass/lattice/commit/f081f9e070ddb749bf9e8afa820c9c13a0026e66))

## [0.3.0](https://github.com/CallumVass/lattice/compare/lattice-v0.2.2...lattice-v0.3.0) (2026-04-16)


### Features

* **agents:** add investigator and jira-planner agents ([8ce1d02](https://github.com/CallumVass/lattice/commit/8ce1d02c6dca01af3ceff2c765ba5d7dc720b063))
* **pipelines:** add investigate and create-jira-issues pipelines ([83a1afc](https://github.com/CallumVass/lattice/commit/83a1afc37fe189bf9f4631ab3f36850fb3c78b3e))
* **skills:** add writing-style skill ([7f9e9e0](https://github.com/CallumVass/lattice/commit/7f9e9e01e1153ea95e6f296994a24ce899f0b25d))

## [0.2.2](https://github.com/CallumVass/lattice/compare/lattice-v0.2.1...lattice-v0.2.2) (2026-04-15)


### Bug Fixes

* align npm publish workflow ([ab1efbe](https://github.com/CallumVass/lattice/commit/ab1efbef026c1f5f13b90f8c68e6b7699afbb010))

## [0.2.1](https://github.com/CallumVass/lattice/compare/lattice-v0.2.0...lattice-v0.2.1) (2026-04-15)


### Bug Fixes

* restore release-please labels ([2d7894a](https://github.com/CallumVass/lattice/commit/2d7894a415072fe1f9d58d5424223c25acbf7fc2))

## [0.2.0](https://github.com/CallumVass/lattice/compare/lattice-v0.1.2...lattice-v0.2.0) (2026-04-15)


### Features

* add architecture pipeline ([6bbe9ea](https://github.com/CallumVass/lattice/commit/6bbe9eae1906deaa34a71119634d986c479855a2))
* lattice — composable agentic pipelines for opencode ([189d3fe](https://github.com/CallumVass/lattice/commit/189d3fe12be88c0ae8058ed10ed227d5cc4b390a))
* package lattice for npm release ([#1](https://github.com/CallumVass/lattice/issues/1)) ([d16def3](https://github.com/CallumVass/lattice/commit/d16def3456616c5373e53a460a78b130bb72847d))


### Bug Fixes

* publish releases from release-please output ([#4](https://github.com/CallumVass/lattice/issues/4)) ([50449fe](https://github.com/CallumVass/lattice/commit/50449fe907ce732c828600155b18be1e7cda5309))
* publish root release-please releases ([#7](https://github.com/CallumVass/lattice/issues/7)) ([a806380](https://github.com/CallumVass/lattice/commit/a806380e724f3de37f7ac2a4061fcb3dfe8fc8dd))

## [0.1.2](https://github.com/CallumVass/lattice/compare/lattice-v0.1.1...lattice-v0.1.2) (2026-04-15)


### Bug Fixes

* publish root release-please releases ([#7](https://github.com/CallumVass/lattice/issues/7)) ([a806380](https://github.com/CallumVass/lattice/commit/a806380e724f3de37f7ac2a4061fcb3dfe8fc8dd))

## [0.1.1](https://github.com/CallumVass/lattice/compare/lattice-v0.1.0...lattice-v0.1.1) (2026-04-15)


### Bug Fixes

* publish releases from release-please output ([#4](https://github.com/CallumVass/lattice/issues/4)) ([50449fe](https://github.com/CallumVass/lattice/commit/50449fe907ce732c828600155b18be1e7cda5309))

## [0.1.0](https://github.com/CallumVass/lattice/compare/lattice-v0.0.1...lattice-v0.1.0) (2026-04-15)


### Features

* add architecture pipeline ([6bbe9ea](https://github.com/CallumVass/lattice/commit/6bbe9eae1906deaa34a71119634d986c479855a2))
* lattice — composable agentic pipelines for opencode ([189d3fe](https://github.com/CallumVass/lattice/commit/189d3fe12be88c0ae8058ed10ed227d5cc4b390a))
* package lattice for npm release ([#1](https://github.com/CallumVass/lattice/issues/1)) ([d16def3](https://github.com/CallumVass/lattice/commit/d16def3456616c5373e53a460a78b130bb72847d))
