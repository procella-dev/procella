# Changelog

## [0.2.0](https://github.com/procella-dev/procella/compare/procella-v0.1.0...procella-v0.2.0) (2026-04-16)


### Features

* add release-please + dev stage, decouple prod deploy from main ([#124](https://github.com/procella-dev/procella/issues/124)) ([f99a6b0](https://github.com/procella-dev/procella/commit/f99a6b0d16586b83569521b9bd8f5c0f6b7a4284))


### Bug Fixes

* add @trpc/server to root devDeps to ensure hoisting ([#134](https://github.com/procella-dev/procella/issues/134)) ([8f0f993](https://github.com/procella-dev/procella/commit/8f0f99322dc09451e0449e921dabd67545c8b12a))
* declare phantom dependencies and update biome to 2.4.12 ([#133](https://github.com/procella-dev/procella/issues/133)) ([ecb7a9b](https://github.com/procella-dev/procella/commit/ecb7a9bacddadc190a5e25fb83b01a3ffe661c26))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.230.0 ([#118](https://github.com/procella-dev/procella/issues/118)) ([bfc7314](https://github.com/procella-dev/procella/commit/bfc73142c966feec086425e61b3cded505556021))
* pin @trpc/server to ~11.12.0 and group tRPC updates ([#135](https://github.com/procella-dev/procella/issues/135)) ([5b5a12f](https://github.com/procella-dev/procella/commit/5b5a12fa0d0bde1ad76199bc6353bde69a63a08b))
* **renovate:** drop Docker, run Renovate directly on runner ([#131](https://github.com/procella-dev/procella/issues/131)) ([a082c96](https://github.com/procella-dev/procella/commit/a082c96de53a93775c43ad004fde2bee6afe83f4))
* **renovate:** mount bun binary directly into Docker container ([#130](https://github.com/procella-dev/procella/issues/130)) ([1cf1122](https://github.com/procella-dev/procella/commit/1cf1122aafac65112234673ff2e44fcb112ad5ff))
* **renovate:** regenerate bun.lock on dependency updates ([#129](https://github.com/procella-dev/procella/issues/129)) ([5478e14](https://github.com/procella-dev/procella/commit/5478e1418f95e578508185508ee71f3691f451ae))
