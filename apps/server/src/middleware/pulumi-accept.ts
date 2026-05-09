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
// HTTP allows multiple media ranges per `Accept` header (RFC 9110 §12.5.1), so
// we scan EVERY `application/vnd.pulumi+N` token and accept if any advertised
// version meets the minimum. The Pulumi CLI itself only sends a single token,
// but a proxy or alternate client could legitimately combine ranges.
//
// The regex enforces a proper media-range boundary after the digits — the
// version must be followed by optional whitespace and then `;` (parameters),
// `,` (next media range), or end-of-string. Without that boundary,
// `application/vnd.pulumi+8evil` would falsely match as v8. Per RFC 9110
// §8.3.2 media types are case-insensitive, so the pattern uses the `i` flag.
//
// References:
//   - pulumi/pulumi `pkg/backend/httpstate/client/api.go` (currentAPIVersion table)
//   - https://github.com/pulumi/pulumi/pull/22699 (v9 bump in v3.233.0)
const MIN_API_VERSION = 8;
const ACCEPT_PATTERN = /application\/vnd\.pulumi\+(\d+)(?=\s*(?:[;,]|$))/gi;

/** Require the Accept header to contain "application/vnd.pulumi+N" with N >= MIN_API_VERSION. */
export function pulumiAccept(): MiddlewareHandler {
	return async (c, next) => {
		const accept = c.req.header("Accept");
		const versions = accept
			? Array.from(accept.matchAll(ACCEPT_PATTERN), (m) => Number.parseInt(m[1], 10)).filter(
					Number.isFinite,
				)
			: [];
		const maxAdvertised = versions.length > 0 ? Math.max(...versions) : Number.NaN;
		if (!Number.isFinite(maxAdvertised) || maxAdvertised < MIN_API_VERSION) {
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
