import { describe, expect, mock, test } from "bun:test";
import type { EscEnvironment, EscEnvironmentRevision, EscService } from "@procella/esc";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { escHandlers } from "./esc.js";

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

const now = new Date("2025-01-01");

const mockEnv: EscEnvironment = {
	id: "env-1",
	projectId: "proj-1",
	name: "staging",
	yamlBody: "values:\n  key: val",
	currentRevisionNumber: 1,
	createdBy: "u-1",
	createdAt: now,
	updatedAt: now,
};

const mockRevision: EscEnvironmentRevision = {
	id: "rev-1",
	environmentId: "env-1",
	revisionNumber: 1,
	yamlBody: "values:\n  key: val",
	createdBy: "u-1",
	createdAt: now,
};

function mockEscService(overrides?: Partial<EscService>): EscService {
	return {
		listProjects: mock(async () => []),
		createEnvironment: mock(async () => mockEnv),
		listEnvironments: mock(async () => [mockEnv]),
		getEnvironment: mock(async () => mockEnv),
		updateEnvironment: mock(async () => mockEnv),
		deleteEnvironment: mock(async () => {}),
		listRevisions: mock(async () => [mockRevision]),
		getRevision: mock(async () => mockRevision),
		openSession: mock(async () => ({
			sessionId: "sess-1",
			values: { key: "val" },
			secrets: [],
			expiresAt: new Date("2025-01-02"),
		})),
		getSession: mock(async () => ({
			sessionId: "sess-1",
			values: { key: "val" },
			secrets: [],
			expiresAt: new Date("2025-01-02"),
		})),
		...overrides,
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

function createTestApp(esc: EscService) {
	const app = new Hono<Env>();
	app.use("*", injectCaller(validCaller));
	app.onError((err, c) => {
		const status = err.message.includes("does not match")
			? 400
			: err.message.includes("not found")
				? 404
				: 500;
		return c.json({ error: err.message }, status);
	});
	const h = escHandlers({ esc });
	app.post("/esc/environments/:org/:project", h.createEnvironment);
	app.get("/esc/environments/:org/:project", h.listEnvironments);
	app.get("/esc/environments/:org/:project/:envName", h.getEnvironment);
	app.patch("/esc/environments/:org/:project/:envName", h.updateEnvironment);
	app.delete("/esc/environments/:org/:project/:envName", h.deleteEnvironment);
	app.get("/esc/environments/:org/:project/:envName/versions", h.listRevisions);
	app.get("/esc/environments/:org/:project/:envName/versions/:version", h.getRevision);
	app.post("/esc/environments/:org/:project/:envName/open", h.openSession);
	app.get("/esc/environments/:org/:project/:envName/open/:sessionId", h.getSession);
	return app;
}

describe("escHandlers", () => {
	describe("createEnvironment", () => {
		test("returns 201 with created environment", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "staging", yamlBody: "values:\n  key: val" }),
			});
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.name).toBe("staging");
			expect(esc.createEnvironment).toHaveBeenCalledTimes(1);
		});
	});

	describe("listEnvironments", () => {
		test("returns 200 with environments array", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.environments).toBeArray();
			expect(body.environments).toHaveLength(1);
		});
	});

	describe("getEnvironment", () => {
		test("returns 200 for existing environment", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.name).toBe("staging");
		});

		test("returns 404 for missing environment", async () => {
			const esc = mockEscService({
				getEnvironment: mock(async () => null),
			});
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/missing");
			expect(res.status).toBe(404);
		});
	});

	describe("updateEnvironment", () => {
		test("returns 200 with updated environment", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ yamlBody: "values:\n  key: new-val" }),
			});
			expect(res.status).toBe(200);
			expect(esc.updateEnvironment).toHaveBeenCalledTimes(1);
		});
	});

	describe("deleteEnvironment", () => {
		test("returns 204", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging", {
				method: "DELETE",
			});
			expect(res.status).toBe(204);
			expect(esc.deleteEnvironment).toHaveBeenCalledTimes(1);
		});
	});

	describe("getRevision", () => {
		test("returns 404 for missing revision", async () => {
			const esc = mockEscService({
				getRevision: mock(async () => null),
			});
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging/versions/99");
			expect(res.status).toBe(404);
		});
	});

	describe("openSession", () => {
		test("returns 201 with session", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging/open", {
				method: "POST",
			});
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.sessionId).toBe("sess-1");
		});

		test("surfaces service errors", async () => {
			const esc = mockEscService({
				openSession: mock(async () => {
					throw new Error("openSession not implemented");
				}),
			});
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/my-org/myproj/staging/open", {
				method: "POST",
			});
			expect(res.status).toBe(500);
		});
	});

	describe("org mismatch", () => {
		test("returns 400 when org does not match caller", async () => {
			const esc = mockEscService();
			const app = createTestApp(esc);

			const res = await app.request("/esc/environments/wrong-org/myproj");
			expect(res.status).toBe(400);
		});
	});
});
