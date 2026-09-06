import { describe, expect, mock, test } from "bun:test";
import { trpcTransformer } from "@procella/api/src/trpc.js";
import type { AuthService } from "@procella/auth";
import type { Caller, SubscriptionTicketScope } from "@procella/types";
import { SignJWT } from "jose";
import { createSubscriptionTicketService } from "../subscription-tickets.js";
import { authenticateTrpcCaller } from "./trpc-auth.js";

const SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
const WRONG_SIGNING_KEY = "wrong-ticket-signing-key-wrong-key";
const ticketStore = {
	consume: async () => true,
};

const caller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "my-org",
	userId: "user-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

const scope: SubscriptionTicketScope = {
	procedure: "updates.onEvents",
	resource: {
		org: "my-org",
		project: "myproj",
		stack: "dev",
		updateId: "upd-1",
	},
};

const stackActivityScope: SubscriptionTicketScope = {
	procedure: "updates.onStackActivity",
	resource: {
		org: "my-org",
		project: "myproj",
		stack: "dev",
	},
};

function subscriptionRequest(
	procedure: string = scope.procedure,
	resource: SubscriptionTicketScope["resource"] = scope.resource,
	options?: { batch?: boolean; envelope?: unknown },
): Request {
	const input = options?.envelope ?? trpcTransformer.serialize(resource);
	const batch = options?.batch ? "&batch=1" : "";
	return new Request(
		`https://procella.dev/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}${batch}`,
		{ method: "GET" },
	);
}

function mockAuthService(returnCaller: Caller | null): AuthService {
	return {
		authenticate: async () => {
			if (!returnCaller) {
				throw new Error("unauthorized");
			}
			return returnCaller;
		},
		authenticateUpdateToken: async () => ({ updateId: "u-1", stackId: "s-1" }),
		resolveUserDisplayName: async () => null,
	};
}

describe("authenticateTrpcCaller", () => {
	test("falls back to header auth when no ticket is present", async () => {
		const result = await authenticateTrpcCaller(
			new Request("https://procella.dev/trpc"),
			undefined,
			{
				auth: mockAuthService(caller),
				verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY, ticketStore)
					.verifyTicket,
			},
		);

		expect(result).toEqual({ caller, invalidTicket: false });
	});

	test("rejects an expired ticket", async () => {
		const expiredTicket = await new SignJWT({
			tenantId: caller.tenantId,
			orgSlug: caller.orgSlug,
			userId: caller.userId,
			login: caller.login,
			roles: [...caller.roles],
			principalType: caller.principalType,
			...scope,
		})
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuer("procella")
			.setAudience("procella:trpc-subscription")
			.setIssuedAt(Math.floor(Date.now() / 1000) - 120)
			.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
			.sign(new TextEncoder().encode(SIGNING_KEY));

		const result = await authenticateTrpcCaller(subscriptionRequest(), expiredTicket, {
			auth: mockAuthService(null),
			verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY, ticketStore)
				.verifyTicket,
		});

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("rejects a wrong-signature ticket", async () => {
		const wrongSignatureTicket = await createSubscriptionTicketService(
			WRONG_SIGNING_KEY,
			ticketStore,
		).issueTicket(caller, scope);

		const result = await authenticateTrpcCaller(subscriptionRequest(), wrongSignatureTicket, {
			auth: mockAuthService(null),
			verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY, ticketStore)
				.verifyTicket,
		});

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("accepts a valid ticket and reconstructs the caller from claims", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, scope);

		const result = await authenticateTrpcCaller(subscriptionRequest(), ticket, {
			auth: mockAuthService(null),
			verifySubscriptionTicket: service.verifyTicket,
		});

		expect(result).toEqual({ caller, invalidTicket: false });
	});

	test("rejects a ticket used for a different procedure", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, scope);

		const result = await authenticateTrpcCaller(
			subscriptionRequest(stackActivityScope.procedure, stackActivityScope.resource),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("rejects a ticket used for a different resource", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, scope);

		const result = await authenticateTrpcCaller(
			subscriptionRequest(scope.procedure, { ...scope.resource, updateId: "upd-2" }),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("rejects an effective SuperJSON scope mismatch without consuming the ticket", async () => {
		const consume = mock(async () => true);
		const store = { consume };
		const service = createSubscriptionTicketService(SIGNING_KEY, store);
		const ticket = await service.issueTicket(caller, scope);
		const envelope = {
			json: { ...scope.resource, otherOrg: "other-org" },
			meta: { referentialEqualities: { otherOrg: ["org"] }, v: 1 },
		};
		const executedInput = trpcTransformer.deserialize(envelope);
		expect(executedInput).toMatchObject({ org: "other-org" });

		const result = await authenticateTrpcCaller(
			subscriptionRequest(scope.procedure, scope.resource, { envelope }),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller: null, invalidTicket: true });
		expect(consume).not.toHaveBeenCalled();
		expect(
			await authenticateTrpcCaller(subscriptionRequest(), ticket, {
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			}),
		).toEqual({ caller, invalidTicket: false });
		expect(consume).toHaveBeenCalledTimes(1);
	});

	test("rejects batch and non-SuperJSON ticket input shapes", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, scope);
		const incompatibleRequests = [
			subscriptionRequest(scope.procedure, scope.resource, { batch: true }),
			subscriptionRequest(scope.procedure, scope.resource, { envelope: scope.resource }),
		];

		for (const request of incompatibleRequests) {
			expect(
				await authenticateTrpcCaller(request, ticket, {
					auth: mockAuthService(null),
					verifySubscriptionTicket: service.verifyTicket,
				}),
			).toEqual({ caller: null, invalidTicket: true });
		}
	});

	test("accepts reconnect envelope fields ignored by the tRPC transformer", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, scope);
		const envelope = { ...trpcTransformer.serialize(scope.resource), lastEventId: 42 };

		const result = await authenticateTrpcCaller(
			subscriptionRequest(scope.procedure, scope.resource, { envelope }),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller, invalidTicket: false });
	});

	test("accepts a stack activity ticket for its intended stack", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, ticketStore);
		const ticket = await service.issueTicket(caller, stackActivityScope);

		const result = await authenticateTrpcCaller(
			subscriptionRequest(stackActivityScope.procedure, stackActivityScope.resource),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller, invalidTicket: false });
	});
});
