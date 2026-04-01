import { describe, expect, mock, test } from "bun:test";
import { OidcExchangeError, type OidcService } from "@procella/oidc";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { oauthHandlers } from "./oauth.js";

function buildApp(oidc: OidcService | null) {
	const app = new Hono<Env>();
	const oauth = oauthHandlers(oidc);
	app.post("/api/oauth/token", oauth.tokenExchange);
	return app;
}

function formBody(overrides?: Record<string, string>) {
	return new URLSearchParams({
		audience: "urn:procella:org:acme",
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		subject_token: "jwt-token",
		subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
		requested_token_type: "urn:procella:oauth:token-type:access_token:org",
		scope: "",
		expiration: "600",
		...overrides,
	}).toString();
}

describe("oauthHandlers", () => {
	test("happy path returns token exchange payload", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => ({
				access_token: "procella-access-token",
				issued_token_type: "urn:procella:oauth:token-type:access_token:org",
				token_type: "Bearer",
				expires_in: 600,
				scope: "",
			})),
		};
		const app = buildApp(oidc);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.access_token).toBe("procella-access-token");
		expect(body.token_type).toBe("Bearer");
		expect(oidc.exchange).toHaveBeenCalledTimes(1);
	});

	test("parses application/x-www-form-urlencoded body correctly", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => ({
				access_token: "t",
				issued_token_type: "org",
				token_type: "Bearer",
				expires_in: 120,
				scope: "custom:scope",
			})),
		};
		const app = buildApp(oidc);

		await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody({ scope: "custom:scope", expiration: "120" }),
		});

		const call = (oidc.exchange as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
			scope: string;
			expiration: number;
		};
		expect(call.scope).toBe("custom:scope");
		expect(call.expiration).toBe(120);
	});

	test("returns 501 when OIDC is disabled", async () => {
		const app = buildApp(null);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.status).toBe(501);
		const body = await res.json();
		expect(body.error).toBe("server_error");
	});

	test("maps OidcExchangeError to RFC6749 error response", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => {
				throw new OidcExchangeError("invalid_target", "audience is invalid", 400);
			}),
		};
		const app = buildApp(oidc);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("invalid_target");
		expect(body.error_description).toBe("audience is invalid");
	});

	test("does not require Accept header", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => ({
				access_token: "t",
				issued_token_type: "org",
				token_type: "Bearer",
				expires_in: 60,
				scope: "",
			})),
		};
		const app = buildApp(oidc);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.status).toBe(200);
	});

	test("does not require Authorization header", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => ({
				access_token: "t",
				issued_token_type: "org",
				token_type: "Bearer",
				expires_in: 60,
				scope: "",
			})),
		};
		const app = buildApp(oidc);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.status).toBe(200);
	});

	test("responds with application/json", async () => {
		const oidc: OidcService = {
			exchange: mock(async () => ({
				access_token: "t",
				issued_token_type: "org",
				token_type: "Bearer",
				expires_in: 60,
				scope: "",
			})),
		};
		const app = buildApp(oidc);

		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody(),
		});

		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
