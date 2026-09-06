import { describe, expect, test } from "bun:test";
import { ConflictError, NotFoundError, ProcellaError } from "@procella/types";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
	adminProcedure,
	protectedProcedure,
	publicProcedure,
	router,
	type TRPCContext,
} from "./trpc.js";

function buildContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		db: {} as never,
		notifications: {} as never,
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		oidcPolicies: null,
		...overrides,
	};
}

interface ErrorResponse {
	error: {
		json: {
			message: string;
			code: number;
			data: {
				code: string;
				httpStatus: number;
				stack?: string;
			};
		};
	};
}

async function formatError(error: Error): Promise<{ response: Response; body: ErrorResponse }> {
	const testRouter = router({
		fail: publicProcedure.query(() => {
			throw error;
		}),
	});
	const response = await fetchRequestHandler({
		endpoint: "/trpc",
		req: new Request("https://procella.test/trpc/fail"),
		router: testRouter,
		createContext: () => buildContext(),
	});

	return { response, body: (await response.json()) as ErrorResponse };
}

describe("trpc procedures", () => {
	test("protectedProcedure rejects unauthenticated callers with UNAUTHORIZED", async () => {
		const testRouter = router({
			whoami: protectedProcedure.query(({ ctx }) => ctx.caller.tenantId),
		});

		const caller = testRouter.createCaller(buildContext({ caller: null }));

		await expect(caller.whoami()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
	});

	test("protectedProcedure proceeds when caller is set", async () => {
		const testRouter = router({
			whoami: protectedProcedure.query(({ ctx }) => ({
				tenantId: ctx.caller.tenantId,
				login: ctx.caller.login,
			})),
		});

		const caller = testRouter.createCaller(buildContext());

		await expect(caller.whoami()).resolves.toEqual({ tenantId: "t-1", login: "admin" });
	});

	test("adminProcedure rejects unauthenticated callers with UNAUTHORIZED", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ctx.caller.roles),
		});

		const caller = testRouter.createCaller(buildContext({ caller: null }));

		await expect(caller.adminOnly()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
	});

	test("adminProcedure rejects non-admin callers with FORBIDDEN", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ctx.caller.roles),
		});

		const caller = testRouter.createCaller(
			buildContext({
				caller: {
					tenantId: "t-1",
					orgSlug: "my-org",
					userId: "u-2",
					login: "viewer",
					roles: ["viewer"],
					principalType: "user",
				},
			}),
		);

		await expect(caller.adminOnly()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Admin role required",
		});
	});

	test("adminProcedure proceeds when caller has admin role", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ({
				tenantId: ctx.caller.tenantId,
				roles: ctx.caller.roles,
			})),
		});

		const caller = testRouter.createCaller(buildContext());

		await expect(caller.adminOnly()).resolves.toEqual({
			tenantId: "t-1",
			roles: ["admin"],
		});
	});
});

describe("trpc error formatting", () => {
	for (const testCase of [
		{
			name: "not found",
			error: new NotFoundError("Stack", "example"),
			message: "Stack not found: example",
			code: "NOT_FOUND",
			jsonRpcCode: -32004,
			status: 404,
		},
		{
			name: "conflict",
			error: new ConflictError("Stack already exists"),
			message: "Stack already exists",
			code: "CONFLICT",
			jsonRpcCode: -32009,
			status: 409,
		},
	]) {
		test(`maps ${testCase.name} domain errors`, async () => {
			const { response, body } = await formatError(testCase.error);

			expect(response.status).toBe(testCase.status);
			expect(body.error.json).toMatchObject({
				message: testCase.message,
				code: testCase.jsonRpcCode,
				data: { code: testCase.code, httpStatus: testCase.status },
			});
			expect(body.error.json.data).not.toHaveProperty("stack");
		});
	}

	test("falls back to a redacted 500 for unmapped domain statuses", async () => {
		const secret = "unexpected domain error details";
		const { response, body } = await formatError(new ProcellaError(secret, "UNKNOWN", 418));

		expect(response.status).toBe(500);
		expect(body.error.json).toMatchObject({
			message: "Internal server error",
			code: -32603,
			data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
		});
		expect(body.error.json.data).not.toHaveProperty("stack");
		expect(JSON.stringify(body)).not.toContain(secret);
	});

	test("redacts non-client error details", async () => {
		const secret = "postgres://secret-internal-connection";
		const { response, body } = await formatError(new Error(secret));

		expect(response.status).toBe(500);
		expect(body.error.json).toMatchObject({
			message: "Internal server error",
			code: -32603,
			data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
		});
		expect(body.error.json.data).not.toHaveProperty("stack");
		expect(JSON.stringify(body)).not.toContain(secret);
	});
});
