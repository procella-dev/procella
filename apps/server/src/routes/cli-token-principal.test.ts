// Regression coverage for M3 — POST /api/auth/cli-token mints long-lived
// Descope access keys, so only interactive user sessions may call it. Machine
// credentials (access keys, workload OIDC identities) must be rejected on BOTH
// route assemblies, which register the handler independently.

import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import type { Hono } from "hono";
import type { Env } from "../types.js";
import { createApp } from "./index.js";
import { createWebApp } from "./web.js";

const authConfig: AuthConfig = {
	mode: "dev",
	token: "session-token",
	userLogin: "alice",
	orgLogin: "my-org",
};

const sessionCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

const accessKeyCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "token:K2accesskey",
	login: "ci-access-key",
	roles: ["admin"],
	principalType: "token",
};

const workloadCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "",
	login: "github-actions:acme/procella",
	roles: ["admin"],
	principalType: "workload",
	workload: {
		provider: "github",
		issuer: "https://token.actions.githubusercontent.com",
		subject: "repo:acme/procella:ref:refs/heads/main",
		repository: "acme/procella",
	},
};

const callersByToken: Record<string, Caller> = {
	"session-token": sessionCaller,
	"access-key-token": accessKeyCaller,
	"workload-token": workloadCaller,
};

function mockAuthService(mintedKeyNames: string[]): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization") ?? "";
			const caller = callersByToken[header.replace(/^token /, "")];
			if (!caller) {
				throw new UnauthorizedError("Invalid token");
			}
			return caller;
		},
		authenticateUpdateToken: async () => ({ updateId: "upd-1", stackId: "stack-1" }),
		resolveUserDisplayName: async () => null,
		createCliAccessKey: async (_caller: Caller, name: string) => {
			mintedKeyNames.push(name);
			return `cli-access-key:${name}`;
		},
	};
}

function makeApiApp(mintedKeyNames: string[]): Hono<Env> {
	return createApp({
		auth: mockAuthService(mintedKeyNames),
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: null,
	});
}

function makeWebApp(mintedKeyNames: string[]): Hono<Env> {
	return createWebApp({
		auth: mockAuthService(mintedKeyNames),
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: null,
	});
}

function cliTokenRequest(authorization: string): [string, RequestInit] {
	return [
		"/api/auth/cli-token",
		{
			method: "POST",
			headers: { Authorization: authorization, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "attacker-minted-key" }),
		},
	];
}

const assemblies: Array<{ name: string; make: (minted: string[]) => Hono<Env> }> = [
	{ name: "createApp", make: makeApiApp },
	{ name: "createWebApp", make: makeWebApp },
];

for (const assembly of assemblies) {
	describe(`POST /api/auth/cli-token principal restriction — ${assembly.name}`, () => {
		test("rejects access-key callers without minting a key", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token access-key-token"));

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "CLI tokens can only be created from an interactive user session",
			});
			expect(minted).toEqual([]);
		});

		test("rejects workload callers without minting a key", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token workload-token"));

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "CLI tokens can only be created from an interactive user session",
			});
			expect(minted).toEqual([]);
		});

		test("still mints for interactive session callers", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token session-token"));

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ token: "cli-access-key:attacker-minted-key" });
			expect(minted).toEqual(["attacker-minted-key"]);
		});

		test("rejects unauthenticated callers", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token bogus-token"));

			expect(res.status).toBe(401);
			expect(minted).toEqual([]);
		});
	});
}
