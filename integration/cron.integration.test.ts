import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { GitHubService } from "@procella/github";
import type { OidcService, TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { createApp } from "../apps/server/src/routes/index.js";
import { PostgresNotificationHub } from "../packages/api/src/notifications.js";

const authConfig: AuthConfig = {
	mode: "dev",
	token: "valid-token",
	userLogin: "test-user",
	orgLogin: "test-org",
};

const baseDeps = {
	auth: {} as AuthService,
	authConfig,
	audit: {} as AuditService,
	db: {
		execute: async () => ({ rows: [{ acquired: false }] }),
		transaction: async (callback: (tx: unknown) => unknown) =>
			callback({ execute: async () => ({ rows: [] }) }),
	} as unknown as Database,
	storage: {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
		exists: async () => false,
	},
	notifications: new PostgresNotificationHub({
		connectionString: "postgres://test:test@localhost:5432/test",
	}),
	github: null as GitHubService | null,
	githubWebhookSecret: undefined,
	stacks: {} as StacksService,
	updates: {} as UpdatesService,
	webhooks: {} as WebhooksService,
	esc: {} as EscService,
	cronSecret: undefined as string | undefined,
	oidc: null as OidcService | null,
	oidcPolicies: null as TrustPolicyRepository | null,
};

function makeApp(cronSecret?: string, db: Database = baseDeps.db) {
	return createApp({ ...baseDeps, cronSecret, db });
}

describe("/cron/gc integration", () => {
	test("returns 401 without secret even in test env", async () => {
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			const res = await makeApp().request("/cron/gc");
			expect(res.status).toBe(401);
		} finally {
			process.env.NODE_ENV = prev;
		}
	});

	test("returns 401 with wrong secret", async () => {
		const res = await makeApp("correct-secret").request("/cron/gc", {
			headers: { Authorization: "Bearer wrong-secret" },
		});
		expect(res.status).toBe(401);
	});

	test("returns 200 with correct secret when GC succeeds", async () => {
		const res = await makeApp("correct-secret").request("/cron/gc", {
			headers: { Authorization: "Bearer correct-secret" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("returns non-2xx after attempting every durable drain when the database fails", async () => {
		let transactions = 0;
		const failingDb = {
			transaction: () => {
				transactions += 1;
				return Promise.reject(new Error("database unavailable"));
			},
		} as unknown as Database;

		const res = await makeApp("correct-secret", failingDb).request("/cron/gc", {
			headers: { Authorization: "Bearer correct-secret" },
		});

		expect(res.status).toBeGreaterThanOrEqual(500);
		// GC cycle, webhook outbox claim, blob cleanup claim.
		expect(transactions).toBe(3);
	});
});
