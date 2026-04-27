import { afterAll, describe, expect, test } from "bun:test";
import { apiRequest, BACKEND_URL, TEST_TOKEN_USER_B, truncateTables } from "./helpers.js";

describe("lease token URL binding", () => {
	afterAll(async () => {
		await truncateTables();
	});

	test("rejects completing an update against a different stack URL", async () => {
		await apiRequest("/stacks/dev-org/lease-binding/attacker-stack", { method: "POST" });
		await apiRequest("/stacks/org-b/lease-binding-victim/victim-stack", {
			method: "POST",
			token: TEST_TOKEN_USER_B,
		});

		const createRes = await apiRequest("/stacks/dev-org/lease-binding/attacker-stack/update", {
			method: "POST",
			body: {},
		});
		expect(createRes.status).toBe(200);
		const { updateID } = await createRes.json();

		const startRes = await apiRequest(
			`/stacks/dev-org/lease-binding/attacker-stack/update/${updateID}`,
			{
				method: "POST",
				body: {},
			},
		);
		expect(startRes.status).toBe(200);
		const { token } = await startRes.json();

		try {
			const completeRes = await fetch(
				`${BACKEND_URL}/api/stacks/org-b/lease-binding-victim/victim-stack/update/${updateID}/complete`,
				{
					method: "POST",
					headers: {
						Authorization: `update-token ${token}`,
						Accept: "application/vnd.pulumi+8",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ status: "succeeded" }),
				},
			);

			expect(completeRes.status).toBe(403);
			expect(await completeRes.json()).toEqual({
				code: "lease_url_mismatch",
				message: "Lease token does not match URL stack",
			});
		} finally {
			await apiRequest(`/stacks/dev-org/lease-binding/attacker-stack/update/${updateID}/cancel`, {
				method: "POST",
			});
		}
	});
});
