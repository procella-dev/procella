import { describe, expect, mock, test } from "bun:test";
import { createCipheriv, hkdfSync } from "node:crypto";
import { AesCryptoService, type StackCryptoInput } from "@procella/crypto";
import type { StackInfo, StacksService } from "@procella/stacks";
import { type Caller, Role, StackNotFoundError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { cryptoHandlers } from "./crypto.js";

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function legacyEncrypt(masterKeyHex: string, stackFQN: string, plaintext: Uint8Array): Uint8Array {
	const key = Buffer.from(
		hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), stackFQN, "procella-encrypt", 32),
	);
	const nonce = Buffer.alloc(12, 7);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return new Uint8Array(Buffer.concat([nonce, encrypted, cipher.getAuthTag()]));
}

function testCaller(overrides: Partial<Caller> = {}): Caller {
	return {
		tenantId: "tenant-a",
		orgSlug: "tenant-a",
		canonicalOrgSlug: "tenant-a",
		userId: "user-1",
		login: "user-1",
		roles: [Role.Admin],
		principalType: "token",
		...overrides,
	};
}

function testStack(overrides: Partial<StackInfo> = {}): StackInfo {
	const now = new Date();
	return {
		id: "11111111-1111-1111-1111-111111111111",
		projectId: "project-1",
		tenantId: "tenant-a",
		orgName: "tenant-a",
		projectName: "myproj",
		stackName: "dev",
		tags: {},
		activeUpdateId: null,
		lastUpdate: null,
		resourceCount: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({}) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => true),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({}) as never),
		getUpdate: mock(async () => ({}) as never),
		getUpdateEvents: mock(async () => ({}) as never),
		getHistory: mock(async () => ({}) as never),
		exportStack: mock(async () => ({}) as never),
		importStack: mock(async () => ({}) as never),
		repairStack: mock(async () => []),
		encryptValue: mock(async (_stack: StackCryptoInput) => new Uint8Array([99, 105, 112])),
		decryptValue: mock(async (_stack: StackCryptoInput) => new Uint8Array([112, 108, 110])),
		batchEncrypt: mock(async (_stack: StackCryptoInput, pts: Uint8Array[]) =>
			pts.map(() => new Uint8Array([99])),
		),
		batchDecrypt: mock(async (_stack: StackCryptoInput, cts: Uint8Array[]) =>
			cts.map(() => new Uint8Array([112])),
		),
		verifyLeaseToken: mock(async () => {}),
		verifyUpdateOwnership: mock(async () => {}),
		...overrides,
	};
}

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
	return {
		createStack: mock(async () => testStack()),
		getStack: mock(async () => testStack()),
		listStacks: mock(async () => []),
		deleteStack: mock(async () => {}),
		renameStack: mock(async () => {}),
		updateStackTags: mock(async () => {}),
		replaceStackTags: mock(async () => {}),
		getStackByFQN: mock(async () => testStack()),
		getStackByNames_systemOnly: mock(async () => testStack()),
		getStackById_systemOnly: mock(async () => testStack()),
		...overrides,
	};
}

function createApp(
	updates: UpdatesService,
	stacks: StacksService,
	caller: Caller = testCaller(),
): Hono<Env> {
	const app = new Hono<Env>();
	app.use("*", async (c, next) => {
		c.set("caller", caller);
		await next();
	});
	const handlers = cryptoHandlers(updates, stacks);
	app.post("/stacks/:org/:project/:stack/encrypt", handlers.encryptValue);
	app.post("/stacks/:org/:project/:stack/decrypt", handlers.decryptValue);
	app.post("/stacks/:org/:project/:stack/batch-encrypt", handlers.batchEncrypt);
	app.post("/stacks/:org/:project/:stack/batch-decrypt", handlers.batchDecrypt);
	app.post("/stacks/:org/:project/:stack/log-decryption", handlers.logDecryption);
	return app;
}

describe("cryptoHandlers", () => {
	test("encryptValue returns base64 ciphertext", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = createApp(updates, stacks);

		const plaintext = toBase64(new Uint8Array([104, 105]));
		const res = await app.request("/stacks/tenant-a/myproj/dev/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).ciphertext).toBe(toBase64(new Uint8Array([99, 105, 112])));
		expect(stacks.getStack).toHaveBeenCalledTimes(1);
		expect(updates.encryptValue).toHaveBeenCalledTimes(1);
	});

	test("encryptValue resolves tenant-owned stack and passes stack identity", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService({
			getStack: mock(async () => testStack({ projectName: "proj1", stackName: "stack1" })),
		});
		const app = createApp(updates, stacks, testCaller({ canonicalOrgSlug: "org1" }));
		await app.request("/stacks/org1/proj1/stack1/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext: toBase64(new Uint8Array([1])) }),
		});

		expect(stacks.getStack).toHaveBeenCalledWith("tenant-a", "org1", "proj1", "stack1");
		const call = (updates.encryptValue as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toEqual({
			stackId: "11111111-1111-1111-1111-111111111111",
			stackFQN: "org1/proj1/stack1",
		});
	});

	test("decryptValue returns base64 plaintext", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const ciphertext = toBase64(new Uint8Array([1, 2, 3]));

		const res = await app.request("/stacks/tenant-a/myproj/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).plaintext).toBe(toBase64(new Uint8Array([112, 108, 110])));
	});

	test("decrypts v1 with canonical org metadata and resolved stack names", async () => {
		const masterKey = "a".repeat(64);
		const crypto = new AesCryptoService(masterKey);
		const resolvedStack = testStack({
			tenantId: "opaque-tenant-id",
			orgName: "opaque-tenant-id",
			projectName: "shared",
			stackName: "dev",
		});
		const canary = new TextEncoder().encode("legacy canary");
		const ciphertext = legacyEncrypt(masterKey, "victim-org/shared/dev", canary);
		const updates = mockUpdatesService({
			decryptValue: mock((input, encrypted) => crypto.decrypt(input, encrypted)),
		});
		const app = createApp(
			updates,
			mockStacksService({ getStack: mock(async () => resolvedStack) }),
			testCaller({
				tenantId: "opaque-tenant-id",
				orgSlug: "current-org",
				canonicalOrgSlug: "victim-org",
			}),
		);

		const res = await app.request("/stacks/current-org/shared/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(ciphertext) }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ plaintext: toBase64(canary) });
		expect(updates.decryptValue).toHaveBeenCalledWith(
			{
				stackId: resolvedStack.id,
				stackFQN: "victim-org/shared/dev",
			},
			ciphertext,
		);
	});

	test("returns uniform 404 when legacy v1 decryption is disabled", async () => {
		const masterKey = "a".repeat(64);
		const crypto = new AesCryptoService(masterKey, { allowLegacyDecryption: false });
		const ciphertext = legacyEncrypt(
			masterKey,
			"tenant-a/myproj/dev",
			new TextEncoder().encode("v1 canary"),
		);
		const updates = mockUpdatesService({
			decryptValue: mock((input, encrypted) => crypto.decrypt(input, encrypted)),
		});
		const app = createApp(updates, mockStacksService());

		const res = await app.request("/stacks/tenant-a/myproj/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(ciphertext) }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "stack_not_found" });
	});

	test("rejects a victim v1 ciphertext when an attacker owns a same-named stack", async () => {
		const masterKey = "a".repeat(64);
		const crypto = new AesCryptoService(masterKey);
		const victimStack = testStack({
			id: "22222222-2222-2222-2222-222222222222",
			tenantId: "victim-tenant",
			orgName: "victim-tenant",
			projectName: "shared",
			stackName: "dev",
		});
		const canary = new TextEncoder().encode("victim canary");
		const victimCiphertext = legacyEncrypt(
			masterKey,
			`${victimStack.tenantId}/${victimStack.projectName}/${victimStack.stackName}`,
			canary,
		);
		const attackerStack = testStack({
			id: "33333333-3333-3333-3333-333333333333",
			tenantId: "attacker-tenant",
			orgName: "attacker-tenant",
			projectName: "shared",
			stackName: "dev",
		});
		const updates = mockUpdatesService({
			decryptValue: mock((input, ciphertext) => crypto.decrypt(input, ciphertext)),
		});
		const app = createApp(
			updates,
			mockStacksService({ getStack: mock(async () => attackerStack) }),
			testCaller({
				tenantId: "attacker-tenant",
				orgSlug: "attacker-tenant",
				canonicalOrgSlug: "attacker-tenant",
			}),
		);

		const res = await app.request("/stacks/victim-tenant/shared/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(victimCiphertext) }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "stack_not_found" });
		expect(updates.decryptValue).not.toHaveBeenCalled();
	});

	test("allows v2 decryption without a legacy org mapping", async () => {
		const masterKey = "a".repeat(64);
		const crypto = new AesCryptoService(masterKey);
		const stack = testStack();
		const plaintext = new TextEncoder().encode("v2 canary");
		const ciphertext = await crypto.encrypt(
			{ stackId: stack.id, stackFQN: "legacy-alias/myproj/dev" },
			plaintext,
		);
		const updates = mockUpdatesService({
			decryptValue: mock((input, encrypted) => crypto.decrypt(input, encrypted)),
		});
		const app = createApp(
			updates,
			mockStacksService({ getStack: mock(async () => stack) }),
			testCaller({ canonicalOrgSlug: undefined }),
		);

		const res = await app.request("/stacks/legacy-alias/myproj/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(ciphertext) }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ plaintext: toBase64(plaintext) });
		expect(updates.decryptValue).toHaveBeenCalledWith({ stackId: stack.id }, ciphertext);
	});

	test("rejects v1 when two tenants claim the same legacy org slug", async () => {
		const masterKey = "a".repeat(64);
		const crypto = new AesCryptoService(masterKey);
		const victimStack = testStack({
			id: "22222222-2222-2222-2222-222222222222",
			tenantId: "victim-tenant",
			projectName: "shared",
			stackName: "dev",
		});
		const attackerStack = testStack({
			id: "33333333-3333-3333-3333-333333333333",
			tenantId: "attacker-tenant",
			projectName: "shared",
			stackName: "dev",
		});
		const ciphertext = legacyEncrypt(
			masterKey,
			"shared-org/shared/dev",
			new TextEncoder().encode("victim canary"),
		);
		const updates = mockUpdatesService({
			decryptValue: mock((input, encrypted) => crypto.decrypt(input, encrypted)),
		});
		const app = createApp(
			updates,
			mockStacksService({ getStack: mock(async () => attackerStack) }),
			testCaller({
				tenantId: attackerStack.tenantId,
				orgSlug: "shared-org",
				canonicalOrgSlug: undefined,
			}),
		);

		const res = await app.request("/stacks/shared-org/shared/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(ciphertext) }),
		});

		expect(victimStack.tenantId).not.toBe(attackerStack.tenantId);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "stack_not_found" });
		expect(updates.decryptValue).toHaveBeenCalledWith({ stackId: attackerStack.id }, ciphertext);
	});

	test("batchEncrypt returns ciphertexts array", async () => {
		const updates = mockUpdatesService();
		const app = createApp(updates, mockStacksService());
		const plaintexts = [toBase64(new Uint8Array([1])), toBase64(new Uint8Array([2]))];

		const res = await app.request("/stacks/tenant-a/myproj/dev/batch-encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintexts }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).ciphertexts).toHaveLength(2);
		expect(updates.batchEncrypt).toHaveBeenCalledTimes(1);
	});

	test("batchDecrypt returns plaintext map", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const ct1 = toBase64(new Uint8Array([10]));
		const ct2 = toBase64(new Uint8Array([20]));

		const res = await app.request("/stacks/tenant-a/myproj/dev/batch-decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertexts: [ct1, ct2] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plaintexts[ct1]).toBeDefined();
		expect(body.plaintexts[ct2]).toBeDefined();
	});

	test("unauthorized stack access returns uniform 404 and skips decrypt", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService({
			getStack: mock(async () => {
				throw new StackNotFoundError("tenant-a", "proj1", "stack1");
			}),
		});
		const app = createApp(updates, stacks);

		const res = await app.request("/stacks/org1/proj1/stack1/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(new Uint8Array([1, 2, 3])) }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "stack_not_found" });
		expect(updates.decryptValue).not.toHaveBeenCalled();
	});

	test("logDecryption returns 200 with empty body", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const res = await app.request("/stacks/myorg/myproj/dev/log-decryption", { method: "POST" });
		expect(res.status).toBe(200);
	});
});
