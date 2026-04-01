import type { OidcService, TokenExchangeRequest } from "@procella/oidc";
import { DEFAULT_EXCHANGE_EXPIRATION, OidcExchangeError } from "@procella/oidc";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types.js";

export function oauthHandlers(oidc: OidcService | null) {
	return {
		tokenExchange: async (c: Context<Env>) => {
			if (!oidc) {
				return c.json({ error: "server_error", error_description: "OIDC is not enabled" }, 501);
			}

			const body = await c.req.parseBody();

			const req: TokenExchangeRequest = {
				audience: String(body.audience ?? ""),
				grantType: String(body.grant_type ?? ""),
				subjectToken: String(body.subject_token ?? ""),
				subjectTokenType: String(body.subject_token_type ?? ""),
				requestedTokenType: String(body.requested_token_type ?? ""),
				scope: String(body.scope ?? ""),
				expiration: Number(body.expiration) || DEFAULT_EXCHANGE_EXPIRATION,
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
				throw err;
			}
		},
	};
}
