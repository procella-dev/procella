// @procella/server — PulumiAccept header validation middleware.

import type { MiddlewareHandler } from "hono";

// Minimum Pulumi API version this server understands. The Pulumi CLI advertises
// its capabilities via `Accept: application/vnd.pulumi+N` on every request, where
// N increments whenever the CLI gains a new ability the service can rely on.
//
// Versions are additive on the CLI side — a v9 client tolerates everything a v8
// client did plus the explicit `{isSecret,value}` SecretValue object form. So a
// server that supports v8 also satisfies any v9+ client. We accept any
// `application/vnd.pulumi+N` with N >= 8, and reject older / non-Pulumi
// `Accept` headers.
//
// References:
//   - pulumi/pulumi `pkg/backend/httpstate/client/api.go` (currentAPIVersion table)
//   - https://github.com/pulumi/pulumi/pull/22699 (v9 bump in v3.233.0)
const MIN_API_VERSION = 8;
const ACCEPT_PATTERN = /application\/vnd\.pulumi\+(\d+)/;

/** Require the Accept header to contain "application/vnd.pulumi+N" with N >= MIN_API_VERSION. */
export function pulumiAccept(): MiddlewareHandler {
	return async (c, next) => {
		const accept = c.req.header("Accept");
		const match = accept?.match(ACCEPT_PATTERN);
		const version = match ? Number.parseInt(match[1], 10) : Number.NaN;
		if (!match || !Number.isFinite(version) || version < MIN_API_VERSION) {
			return c.json(
				{
					code: 415,
					message: `Missing required Accept header: application/vnd.pulumi+${MIN_API_VERSION} (or newer)`,
				},
				415,
			);
		}
		await next();
	};
}
