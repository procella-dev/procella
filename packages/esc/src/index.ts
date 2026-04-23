// @procella/esc — Pulumi ESC (Environments, Secrets & Config) service.
//
// Implements the backend for the `esc` CLI and the dashboard: YAML-based
// environment definitions with composition (imports) and dynamic credential
// providers. Value resolution is delegated to a Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc as a library.
//
// P0.2 scaffold: interfaces, types, and PostgresEscService skeleton. CRUD
// implementation lands in procella-yj7.6 (P1); evaluator wiring in .14 (P2).

export * from "./service.js";
export * from "./types.js";
