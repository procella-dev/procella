import type { OidcService, TokenExchangeRequest } from "@procella/oidc";
import { DEFAULT_EXCHANGE_EXPIRATION, OidcExchangeError } from "@procella/oidc";
import { projectError } from "@procella/types";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types.js";

export function oauthHandlers(oidc: OidcService | null) {
	return {
		tokenExchange: async (c: Context<Env>) => {
			if (!oidc) {
				return c.json({ error: "server_error", error_description: "OIDC is not enabled" }, 501);
			}

			// Accept both application/x-www-form-urlencoded (Pulumi CLI) and
			// application/json (pulumi/auth-actions via axios)
			const contentType = c.req.header("Content-Type") ?? "";
			let rawBody: Record<string, string>;
			if (contentType.includes("application/json")) {
				rawBody = await c.req.json<Record<string, string>>();
			} else {
				const formBody = await c.req.parseBody();
				rawBody = Object.fromEntries(Object.entries(formBody).map(([k, v]) => [k, String(v)]));
			}

			const req: TokenExchangeRequest = {
				audience: String(rawBody.audience ?? ""),
				grantType: String(rawBody.grant_type ?? ""),
				subjectToken: String(rawBody.subject_token ?? ""),
				subjectTokenType: String(rawBody.subject_token_type ?? ""),
				requestedTokenType: String(rawBody.requested_token_type ?? ""),
				scope: String(rawBody.scope ?? ""),
				expiration: Number(rawBody.expiration) || DEFAULT_EXCHANGE_EXPIRATION,
			};

			try {
				const response = await oidc.exchange(req);
				return c.json(response);
			} catch (err) {
				if (err instanceof OidcExchangeError) {
					return c.json(
						{ error: err.error, error_description: err.errorDescription },
						err.statusCode as ContentfulStatusCode,
					);
				}
				// Log unexpected errors and return server_error to avoid leaking internals
				console.error("[oauth] token exchange failed:", projectError(err));
				return c.json(
					{
						error: "server_error",
						// Do not echo internal error details to unauthenticated callers
						error_description: "Token exchange failed",
					},
					500 as ContentfulStatusCode,
				);
			}
		},
	};
}
