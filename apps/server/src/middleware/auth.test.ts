import { describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import type { StacksService } from "@procella/stacks";
import { UnauthorizedError } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { updateAuth } from "./auth.js";

function mockAuthService(): AuthService {
	return {
		authenticate: async () => {
			throw new UnauthorizedError("not used");
		},
		authenticateUpdateToken: async () => ({
			updateId: "upd-1",
			stackId: "stack-a-id",
		}),
	};
}

function mockStacksService(): Pick<StacksService, "getStackByNames_systemOnly"> {
	return {
		getStackByNames_systemOnly: async () => ({
			id: "stack-b-id",
			projectId: "proj-1",
			tenantId: "tenant-b",
			orgName: "victim-org",
			projectName: "victim-proj",
			stackName: "victim-stack",
			tags: {},
			activeUpdateId: null,
			lastUpdate: null,
			resourceCount: null,
			createdAt: new Date("2025-01-01T00:00:00Z"),
			updatedAt: new Date("2025-01-01T00:00:00Z"),
		}),
	};
}

describe("updateAuth lease binding", () => {
	test("returns 403 when lease token stack does not match URL stack", async () => {
		const app = new Hono<Env>();
		app.use(
			"/stacks/:org/:project/:stack/update/:updateId/complete",
			updateAuth(mockAuthService(), async () => {}, mockStacksService()),
		);
		app.post("/stacks/:org/:project/:stack/update/:updateId/complete", (c) => c.body(null, 204));

		const res = await app.request(
			"/stacks/victim-org/victim-proj/victim-stack/update/upd-1/complete",
			{
				method: "POST",
				headers: { Authorization: "update-token update:upd-1:stack-a-id:secret" },
			},
		);

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			code: "lease_url_mismatch",
			message: "Lease token does not match URL stack",
		});
	});
});
