# Changelog

## [0.2.0](https://github.com/procella-dev/procella/compare/procella-v0.1.0...procella-v0.2.0) (2026-04-26)


### Features

* add release-please + dev stage, decouple prod deploy from main ([#124](https://github.com/procella-dev/procella/issues/124)) ([f99a6b0](https://github.com/procella-dev/procella/commit/f99a6b0d16586b83569521b9bd8f5c0f6b7a4284))
* **esc:** full Pulumi ESC equivalent — backend, evaluator, providers, UI (procella-yj7 epic) ([#140](https://github.com/procella-dev/procella/issues/140)) ([048989b](https://github.com/procella-dev/procella/commit/048989b24bd805fd5ad4bb06811efa1edb1312d9))


### Bug Fixes

* add @trpc/server to root devDeps to ensure hoisting ([#134](https://github.com/procella-dev/procella/issues/134)) ([8f0f993](https://github.com/procella-dev/procella/commit/8f0f99322dc09451e0449e921dabd67545c8b12a))
* declare phantom dependencies and update biome to 2.4.12 ([#133](https://github.com/procella-dev/procella/issues/133)) ([ecb7a9b](https://github.com/procella-dev/procella/commit/ecb7a9bacddadc190a5e25fb83b01a3ffe661c26))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.215.0 ([#137](https://github.com/procella-dev/procella/issues/137)) ([6833255](https://github.com/procella-dev/procella/commit/683325584d9577a0455b61a6bb9965cae8365ad1))
* **deps:** update module github.com/aws/aws-lambda-go to v1.54.0 ([#145](https://github.com/procella-dev/procella/issues/145)) ([2a74ea8](https://github.com/procella-dev/procella/commit/2a74ea83a8d0e449699bb6748efd29ae44f70a56))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.230.0 ([#118](https://github.com/procella-dev/procella/issues/118)) ([bfc7314](https://github.com/procella-dev/procella/commit/bfc73142c966feec086425e61b3cded505556021))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.232.0 ([#136](https://github.com/procella-dev/procella/issues/136)) ([5cddbb3](https://github.com/procella-dev/procella/commit/5cddbb30b1b8810fc82ad50b229ba74dc16b3cc3))
* **e2e:** warm up server to reduce sharded cold-start flakes ([#142](https://github.com/procella-dev/procella/issues/142)) ([f78f3e6](https://github.com/procella-dev/procella/commit/f78f3e65e9a424026193405cae93df9528705019))
* pin @trpc/server to ~11.12.0 and group tRPC updates ([#135](https://github.com/procella-dev/procella/issues/135)) ([5b5a12f](https://github.com/procella-dev/procella/commit/5b5a12fa0d0bde1ad76199bc6353bde69a63a08b))
* pin bun install to hoisted layout to avoid TS2742 on isolated installs ([#144](https://github.com/procella-dev/procella/issues/144)) ([5e881c3](https://github.com/procella-dev/procella/commit/5e881c3748848928f0f88de64d18eacf23e183a1))
* **renovate:** drop Docker, run Renovate directly on runner ([#131](https://github.com/procella-dev/procella/issues/131)) ([a082c96](https://github.com/procella-dev/procella/commit/a082c96de53a93775c43ad004fde2bee6afe83f4))
* **renovate:** mount bun binary directly into Docker container ([#130](https://github.com/procella-dev/procella/issues/130)) ([1cf1122](https://github.com/procella-dev/procella/commit/1cf1122aafac65112234673ff2e44fcb112ad5ff))
* **renovate:** regenerate bun.lock on dependency updates ([#129](https://github.com/procella-dev/procella/issues/129)) ([5478e14](https://github.com/procella-dev/procella/commit/5478e1418f95e578508185508ee71f3691f451ae))


### Performance Improvements

* **ci:** adopt Bun 1.3.13 --parallel (unit) and --shard (e2e) ([#141](https://github.com/procella-dev/procella/issues/141)) ([8a3b072](https://github.com/procella-dev/procella/commit/8a3b0721c67d99846481ded3f76af905e5ebbf76))
* **ui:** lazy-load route components to drop main bundle below 500 kB ([#143](https://github.com/procella-dev/procella/issues/143)) ([d52529d](https://github.com/procella-dev/procella/commit/d52529daa00cd90a9fd5d8038d526c3b392a3b35))
