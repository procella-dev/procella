import { describe, expect, mock, test } from "bun:test";
import type { Caller, SubscriptionTicketScope } from "@procella/types";
import { decodeJwt, SignJWT } from "jose";
import {
	createSubscriptionTicketService,
	SUBSCRIPTION_TICKET_TTL_SECONDS,
	type SubscriptionTicketStore,
} from "./subscription-tickets.js";

const SIGNING_KEY = "ticket-signing-key-ticket-signing-key";

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

function createStore(): SubscriptionTicketStore {
	return {
		consume: mock(async () => true),
	};
}

describe("subscription ticket service", () => {
	test("issues a valid JWT with a 60 second expiration", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, createStore());
		const ticket = await service.issueTicket(caller, scope);
		const payload = decodeJwt(ticket);
		const issuedAt = payload.iat;
		const expiresAt = payload.exp;

		expect(typeof issuedAt).toBe("number");
		expect(typeof expiresAt).toBe("number");
		if (typeof issuedAt !== "number" || typeof expiresAt !== "number") {
			throw new Error("Ticket payload is missing iat/exp claims");
		}
		expect(expiresAt - issuedAt).toBe(SUBSCRIPTION_TICKET_TTL_SECONDS);
		expect(payload.tenantId).toBe(caller.tenantId);
		expect(payload.userId).toBe(caller.userId);
		expect(payload.login).toBe(caller.login);
		expect(payload.procedure).toBe(scope.procedure);
		expect(payload.resource).toEqual(scope.resource);
		expect(typeof payload.jti).toBe("string");
	});

	test("reconstructs the caller from a valid ticket", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY, createStore());
		const ticket = await service.issueTicket(caller, scope);

		expect(await service.verifyTicket(ticket, scope)).toEqual(caller);
	});

	test("validates scope before consuming the nonce", async () => {
		const store = createStore();
		const service = createSubscriptionTicketService(SIGNING_KEY, store);
		const ticket = await service.issueTicket(caller, scope);
		const wrongScope: SubscriptionTicketScope = {
			...scope,
			resource: { ...scope.resource, updateId: "upd-2" },
		};

		await expect(service.verifyTicket(ticket, wrongScope)).rejects.toThrow(
			"Subscription ticket scope does not match request",
		);
		expect(store.consume).not.toHaveBeenCalled();
		expect(await service.verifyTicket(ticket, scope)).toEqual(caller);
		expect(store.consume).toHaveBeenCalledTimes(1);
	});

	test("rejects expiry before consuming the nonce", async () => {
		const store = createStore();
		const expiredTicket = await new SignJWT({ ...caller, ...scope })
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuer("procella")
			.setAudience("procella:trpc-subscription")
			.setJti(crypto.randomUUID())
			.setIssuedAt(Math.floor(Date.now() / 1000) - 120)
			.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
			.sign(new TextEncoder().encode(SIGNING_KEY));
		const service = createSubscriptionTicketService(SIGNING_KEY, store);

		await expect(service.verifyTicket(expiredTicket, scope)).rejects.toThrow();
		expect(store.consume).not.toHaveBeenCalled();
	});
});
