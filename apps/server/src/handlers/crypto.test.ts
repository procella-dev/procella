import { describe, expect, mock, test } from "bun:test";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { cryptoHandlers } from "./crypto.js";

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({}) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
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
		encryptValue: mock(async () => new Uint8Array([99, 105, 112])),
		decryptValue: mock(async () => new Uint8Array([112, 108, 110])),
		batchEncrypt: mock(async (_fqn: string, pts: Uint8Array[]) =>
			pts.map(() => new Uint8Array([99])),
		),
		batchDecrypt: mock(async (_fqn: string, cts: Uint8Array[]) =>
			cts.map(() => new Uint8Array([112])),
		),
		verifyLeaseToken: mock(async () => {}),
		...overrides,
	};
}

describe("cryptoHandlers", () => {
	test("encryptValue returns base64 ciphertext", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/encrypt", h.encryptValue);

		const plaintext = toBase64(new Uint8Array([104, 105]));
		const res = await app.request("/stacks/myorg/myproj/dev/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ciphertext).toBe(toBase64(new Uint8Array([99, 105, 112])));
		expect(updates.encryptValue).toHaveBeenCalledTimes(1);
	});

	test("encryptValue passes correct stackFQN", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/encrypt", h.encryptValue);

		const plaintext = toBase64(new Uint8Array([1]));
		await app.request("/stacks/org1/proj1/stack1/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext }),
		});

		const call = (updates.encryptValue as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("org1/proj1/stack1");
	});

	test("decryptValue returns base64 plaintext", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/decrypt", h.decryptValue);

		const ciphertext = toBase64(new Uint8Array([1, 2, 3]));
		const res = await app.request("/stacks/myorg/myproj/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plaintext).toBe(toBase64(new Uint8Array([112, 108, 110])));
	});

	test("batchEncrypt returns ciphertexts array", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/batch-encrypt", h.batchEncrypt);

		const plaintexts = [toBase64(new Uint8Array([1])), toBase64(new Uint8Array([2]))];
		const res = await app.request("/stacks/myorg/myproj/dev/batch-encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintexts }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ciphertexts).toBeArray();
		expect(body.ciphertexts).toHaveLength(2);
		expect(updates.batchEncrypt).toHaveBeenCalledTimes(1);
	});

	test("batchDecrypt returns plaintexts map", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/batch-decrypt", h.batchDecrypt);

		const ct1 = toBase64(new Uint8Array([10]));
		const ct2 = toBase64(new Uint8Array([20]));
		const res = await app.request("/stacks/myorg/myproj/dev/batch-decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertexts: [ct1, ct2] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plaintexts).toBeDefined();
		expect(typeof body.plaintexts).toBe("object");
		expect(body.plaintexts[ct1]).toBeDefined();
		expect(body.plaintexts[ct2]).toBeDefined();
	});

	test("batchEncrypt handles empty plaintexts", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/batch-encrypt", h.batchEncrypt);

		const res = await app.request("/stacks/myorg/myproj/dev/batch-encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ciphertexts).toBeArray();
		expect(body.ciphertexts).toHaveLength(0);
	});

	test("logDecryption returns 200 with empty body", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = cryptoHandlers(updates);
		app.post("/stacks/:org/:project/:stack/log-decryption", h.logDecryption);

		const res = await app.request("/stacks/myorg/myproj/dev/log-decryption", {
			method: "POST",
		});

		expect(res.status).toBe(200);
	});
});
