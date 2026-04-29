# Changelog

## [3.0.2](https://github.com/CallumVass/lattice/compare/lattice-v3.0.1...lattice-v3.0.2) (2026-04-29)


### Bug Fixes

* include opencode plugin runtime dependency ([4e4033c](https://github.com/CallumVass/lattice/commit/4e4033c21220928ee77bcfe7420a7617b0a3f509))

## [3.0.1](https://github.com/CallumVass/lattice/compare/lattice-v3.0.0...lattice-v3.0.1) (2026-04-29)


### Bug Fixes

* **plugin:** improve pause guidance questions ([9a53090](https://github.com/CallumVass/lattice/commit/9a530903e6a21c7a06302996759427dda2ac17ed))

## [3.0.0](https://github.com/CallumVass/lattice/compare/lattice-v2.9.0...lattice-v3.0.0) (2026-04-28)


### ⚠ BREAKING CHANGES

* **plugin:** removes legacy /lattice-* commands, individual lattice control tools, hard gates, post-hooks, and old stage schema names in favor of /lattice, lattice_control, explicit pause state, context, signal, pass, and fail.

### Features

* **plugin:** consolidate lattice control UX ([2552b59](https://github.com/CallumVass/lattice/commit/2552b5922dfd17bd922200b3b40eb7fce46b7daa))

## [2.9.0](https://github.com/CallumVass/lattice/compare/lattice-v2.8.0...lattice-v2.9.0) (2026-04-28)


### Features

* **pipelines:** expose manifest context to expanded stages ([41761ac](https://github.com/CallumVass/lattice/commit/41761acd2fbbdb78a5cc28c74a4192fdf53e893d))

## [2.8.0](https://github.com/CallumVass/lattice/compare/lattice-v2.7.0...lattice-v2.8.0) (2026-04-27)


### Features

* **plugin:** preserve observed telemetry metadata ([c2d2dd9](https://github.com/CallumVass/lattice/commit/c2d2dd9a4238c70fab703bfc6f96f48bff77545c))

## [2.7.0](https://github.com/CallumVass/lattice/compare/lattice-v2.6.0...lattice-v2.7.0) (2026-04-27)


### Features

* **plugin:** add dynamic stages and safer progression ([1cd9b09](https://github.com/CallumVass/lattice/commit/1cd9b09bcd2858d2858b3ced9295dc9d0aa72197))

## [2.6.0](https://github.com/CallumVass/lattice/compare/lattice-v2.5.0...lattice-v2.6.0) (2026-04-22)


### Features

* **plugin:** add /lattice-approve for gate releases and /lattice-reset for stuck runs ([325f2df](https://github.com/CallumVass/lattice/commit/325f2df40da73713f496bcacf51cfa63c3e8b9a1))

## [2.5.0](https://github.com/CallumVass/lattice/compare/lattice-v2.4.0...lattice-v2.5.0) (2026-04-22)


### Features

* **pipelines:** bounded rewinds, explicit rewind targets, hard-gated pauses ([99bdda5](https://github.com/CallumVass/lattice/commit/99bdda538798f43649d6d66f572aa5c7cbe9bcac))

## [2.4.0](https://github.com/CallumVass/lattice/compare/lattice-v2.3.0...lattice-v2.4.0) (2026-04-21)


### Features

* **plugin:** add model overrides, post-hook progress, and lattice_proceed ([b618561](https://github.com/CallumVass/lattice/commit/b618561c539027155f1a43b7a7d9fbabfc0bb1db))

## [2.3.0](https://github.com/CallumVass/lattice/compare/lattice-v2.2.0...lattice-v2.3.0) (2026-04-20)


### Features

* **stage:** add post-hook with agent-feedback retry loop ([84ca984](https://github.com/CallumVass/lattice/commit/84ca98456e800c45374e5b9e9fec3e7fc6cddb37))

## [2.2.0](https://github.com/CallumVass/lattice/compare/lattice-v2.1.0...lattice-v2.2.0) (2026-04-18)


### Features

* **skills:** add skills.disabled flag to short-circuit injection ([edd7c26](https://github.com/CallumVass/lattice/commit/edd7c26095a6119a76988494cdfbb62fdc3bcb0a))

## [2.1.0](https://github.com/CallumVass/lattice/compare/lattice-v2.0.0...lattice-v2.1.0) (2026-04-18)


### Features

* capture per-stage opencode telemetry ([2e482ef](https://github.com/CallumVass/lattice/commit/2e482efa4cb9100558ca9c031dd33d42164b9a63))

## [2.0.0](https://github.com/CallumVass/lattice/compare/lattice-v1.6.0...lattice-v2.0.0) (2026-04-18)


### ⚠ BREAKING CHANGES

* `tool_signal` stages must declare a non-empty `signals` array. The builder's StageOptions is a discriminated union so TypeScript enforces this at compile time; `pipelineDefinitionSchema` enforces it at runtime for JSON/JS pipelines. `idle` stages must not set `signals`.
* `plan_created` and `plan_complete` removed from the `CompletionMethod` enum. Pipelines using them must migrate to `tool_signal` and carry any file-path convention in the stage `prompt`.
* Lattice no longer ships built-in pipelines (/architecture, /implement, /review, /review-lite, /investigate, /create-jira-issues), bundled agents, bundled skills, or the learnings capture/injection/insights system. The /lattice-insights and /lattice-learning-feedback commands are removed, the `kill` arg on /lattice-retry is removed, and the `learnings` config key is no longer recognised. Users upgrading from v1 must supply their own pipeline/agent/skill files in the paths above.

### Features

* drop plan_created/plan_complete completion modes ([c120361](https://github.com/CallumVass/lattice/commit/c1203619a39d17a2c3814ae3fdc697bf47cf1884))
* per-stage signal declaration + custom pause prompts ([8ceff32](https://github.com/CallumVass/lattice/commit/8ceff3239e20a01094ddbef6905b38e0863f9f74))
* v2 framework-only release ([b86f01f](https://github.com/CallumVass/lattice/commit/b86f01f23b6378e7dbca26a5226a5af8d5031e0a))

## [1.6.0](https://github.com/CallumVass/lattice/compare/lattice-v1.5.0...lattice-v1.6.0) (2026-04-17)


### Features

* **learnings:** jira drafter NFRs + insights surface ([3377bc4](https://github.com/CallumVass/lattice/commit/3377bc491f97df4112aca7f2c0a2cab6767cc9e0))

## [1.5.0](https://github.com/CallumVass/lattice/compare/lattice-v1.4.0...lattice-v1.5.0) (2026-04-17)


### Features

* **learnings:** per-finding edit, negative signal, decay, feedback ([bd039d0](https://github.com/CallumVass/lattice/commit/bd039d0b700580169b8bbf2449225c901e233162))

## [1.4.0](https://github.com/CallumVass/lattice/compare/lattice-v1.3.0...lattice-v1.4.0) (2026-04-17)


### Features

* **learnings:** inject learnings into planner stage ([ab7ae29](https://github.com/CallumVass/lattice/commit/ab7ae29a4c7e8bf565994ad50468e8316c128298))

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
