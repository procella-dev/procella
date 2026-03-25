// E2E — Concurrency stress tests: verify upserts handle parallel writes without 500s.
//
// These tests simulate what happens when a Pulumi CLI sends many concurrent
// checkpoint and event requests during a large `pulumi up` — especially with
// multiple server replicas behind a load balancer.

import { afterAll, describe, expect, test } from "bun:test";
import { apiRequest, BACKEND_URL, truncateTables } from "./helpers.js";

const CONCURRENCY = 20;

async function updateRequest(
	path: string,
	token: string,
	opts?: { method?: string; body?: unknown },
): Promise<Response> {
	return fetch(`${BACKEND_URL}/api${path}`, {
		method: opts?.method ?? "GET",
		headers: {
			Authorization: `update-token ${token}`,
			Accept: "application/vnd.pulumi+8",
			...(opts?.body ? { "Content-Type": "application/json" } : {}),
		},
		body: opts?.body ? JSON.stringify(opts.body) : undefined,
	});
}

async function setupUpdate(suffix: string): Promise<{
	stackPath: string;
	updateId: string;
	leaseToken: string;
}> {
	const stackPath = `/stacks/dev-org/concurrency-proj/stress-${suffix}`;
	await apiRequest(stackPath, { method: "POST" });

	const createRes = await apiRequest(`${stackPath}/update`, {
		method: "POST",
		body: {},
	});
	expect(createRes.status).toBe(200);
	const { updateID } = (await createRes.json()) as { updateID: string };

	const startRes = await apiRequest(`${stackPath}/update/${updateID}`, {
		method: "POST",
		body: {},
	});
	expect(startRes.status).toBe(200);
	const { token } = (await startRes.json()) as { token: string };

	return { stackPath, updateId: updateID, leaseToken: token };
}

afterAll(async () => {
	await truncateTables();
});

describe("concurrency stress", () => {
	test("parallel checkpoint writes do not cause 500 errors", async () => {
		const { stackPath, updateId, leaseToken } = await setupUpdate("ckpt");
		const checkpoint = {
			version: 3,
			deployment: {
				manifest: { time: new Date().toISOString(), magic: "test", version: "" },
				resources: Array.from({ length: 50 }, (_, i) => ({
					urn: `urn:pulumi:dev::test::random:index/randomString:RandomString::r${i}`,
					type: "random:index/randomString:RandomString",
					custom: true,
					id: `id-${i}`,
					inputs: { length: 16 },
					outputs: { result: `value-${i}` },
				})),
			},
		};

		const results = await Promise.all(
			Array.from({ length: CONCURRENCY }, (_, i) =>
				updateRequest(`${stackPath}/update/${updateId}/checkpoint`, leaseToken, {
					method: "PATCH",
					body: {
						sequenceNumber: i + 1,
						...checkpoint,
					},
				}),
			),
		);

		const statuses = results.map((r) => r.status);
		const failures = statuses.filter((s) => s >= 500);
		expect(failures).toEqual([]);

		await updateRequest(`${stackPath}/update/${updateId}/complete`, leaseToken, {
			method: "POST",
			body: { status: "succeeded" },
		});
	});

	test("parallel event batch writes do not cause 500 errors", async () => {
		const { stackPath, updateId, leaseToken } = await setupUpdate("evt");

		const results = await Promise.all(
			Array.from({ length: CONCURRENCY }, (_, batchIdx) =>
				updateRequest(`${stackPath}/update/${updateId}/events/batch`, leaseToken, {
					method: "POST",
					body: {
						events: Array.from({ length: 10 }, (_, evtIdx) => ({
							sequence: batchIdx * 10 + evtIdx,
							stdoutEvent: { message: `batch-${batchIdx}-evt-${evtIdx}` },
						})),
					},
				}),
			),
		);

		const statuses = results.map((r) => r.status);
		const failures = statuses.filter((s) => s >= 500);
		expect(failures).toEqual([]);

		await updateRequest(`${stackPath}/update/${updateId}/complete`, leaseToken, {
			method: "POST",
			body: { status: "succeeded" },
		});
	});

	test("overlapping event batches with duplicate sequences do not cause 500 errors", async () => {
		const { stackPath, updateId, leaseToken } = await setupUpdate("dup-evt");

		// All batches intentionally send the SAME sequence numbers — simulates
		// the CLI retrying or multiple replicas receiving the same batch.
		const results = await Promise.all(
			Array.from({ length: CONCURRENCY }, (_, batchIdx) =>
				updateRequest(`${stackPath}/update/${updateId}/events/batch`, leaseToken, {
					method: "POST",
					body: {
						events: Array.from({ length: 5 }, (_, evtIdx) => ({
							sequence: evtIdx,
							stdoutEvent: { message: `dup-batch-${batchIdx}-evt-${evtIdx}` },
						})),
					},
				}),
			),
		);

		const statuses = results.map((r) => r.status);
		const failures = statuses.filter((s) => s >= 500);
		expect(failures).toEqual([]);

		await updateRequest(`${stackPath}/update/${updateId}/complete`, leaseToken, {
			method: "POST",
			body: { status: "succeeded" },
		});
	});

	test("mixed concurrent checkpoints and events do not cause 500 errors", async () => {
		const { stackPath, updateId, leaseToken } = await setupUpdate("mixed");
		const checkpoint = {
			version: 3,
			deployment: {
				manifest: { time: new Date().toISOString(), magic: "test", version: "" },
				resources: [
					{
						urn: "urn:pulumi:dev::test::random:index/randomString:RandomString::r0",
						type: "random:index/randomString:RandomString",
						custom: true,
						id: "id-0",
						inputs: { length: 16 },
						outputs: { result: "value-0" },
					},
				],
			},
		};

		const requests = Array.from({ length: CONCURRENCY }, (_, i) => {
			if (i % 2 === 0) {
				return updateRequest(`${stackPath}/update/${updateId}/checkpoint`, leaseToken, {
					method: "PATCH",
					body: { sequenceNumber: i + 1, ...checkpoint },
				});
			}
			return updateRequest(`${stackPath}/update/${updateId}/events/batch`, leaseToken, {
				method: "POST",
				body: {
					events: [{ sequence: i, stdoutEvent: { message: `mixed-${i}` } }],
				},
			});
		});

		const results = await Promise.all(requests);
		const statuses = results.map((r) => r.status);
		const failures = statuses.filter((s) => s >= 500);
		expect(failures).toEqual([]);

		await updateRequest(`${stackPath}/update/${updateId}/complete`, leaseToken, {
			method: "POST",
			body: { status: "succeeded" },
		});
	});
});
