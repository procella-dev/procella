import { describe, expect, test } from "bun:test";
import type { Caller } from "@procella/types";
import { decodeJwt } from "jose";
import {
	createSubscriptionTicketService,
	SUBSCRIPTION_TICKET_TTL_SECONDS,
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

describe("subscription ticket service", () => {
	test("issues a valid JWT with a 60 second expiration", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY);
		const ticket = await service.issueTicket(caller);
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
	});

	test("reconstructs the caller from a valid ticket", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY);
		const ticket = await service.issueTicket(caller);

		expect(await service.verifyTicket(ticket)).toEqual(caller);
	});
});
