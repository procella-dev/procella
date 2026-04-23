// @procella/esc — Pulumi ESC (Environments, Secrets & Config) service.
//
// Implements the backend for the `esc` CLI and the dashboard: YAML-based
// environment definitions with composition (imports) and dynamic credential
// providers. Value resolution is delegated to a Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc as a library.
//
// Current status: CRUD + session scaffolding implemented (procella-yj7.5, .6).
// openSession/getSession + recursive import resolution land in procella-yj7.14
// once the evaluator Lambda is wired up (procella-yj7.11/.12/.13).

export { UnimplementedEvaluatorClient } from "./evaluator-client.js";
export * from "./service.js";
export * from "./types.js";
