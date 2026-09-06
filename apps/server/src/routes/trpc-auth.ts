import { trpcTransformer } from "@procella/api/src/trpc.js";
import type { AuthService } from "@procella/auth";
import {
	type Caller,
	type SubscriptionTicketScope,
	subscriptionTicketScopeSchema,
} from "@procella/types";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

export interface TrpcAuthDeps {
	auth: AuthService;
	verifySubscriptionTicket?: (ticket: string, scope: SubscriptionTicketScope) => Promise<Caller>;
}

export async function authenticateTrpcCaller(
	req: Request,
	ticket: string | undefined,
	deps: TrpcAuthDeps,
): Promise<{ caller: Caller | null; invalidTicket: boolean }> {
	if (req.method === "GET" && ticket && !req.headers.get("Authorization")) {
		if (!deps.verifySubscriptionTicket) {
			return { caller: null, invalidTicket: false };
		}
		try {
			const scope = subscriptionScopeFromRequest(req);
			if (!scope) {
				return { caller: null, invalidTicket: true };
			}
			return {
				caller: await deps.verifySubscriptionTicket(ticket, scope),
				invalidTicket: false,
			};
		} catch {
			return { caller: null, invalidTicket: true };
		}
	}

	return {
		caller: await deps.auth.authenticate(req).catch(() => null),
		invalidTicket: false,
	};
}

export function trpcAuth(deps: TrpcAuthDeps): MiddlewareHandler<Env> {
	return async (c, next) => {
		const { caller, invalidTicket } = await authenticateTrpcCaller(
			c.req.raw,
			c.req.query("ticket"),
			deps,
		);
		if (invalidTicket) {
			return c.json({ code: "invalid_ticket" }, 401);
		}
		if (!caller) {
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}
		c.set("caller", caller);
		await next();
	};
}

function subscriptionScopeFromRequest(req: Request): SubscriptionTicketScope | null {
	const url = new URL(req.url);
	if (url.searchParams.get("batch") === "1") {
		return null;
	}

	const trpcPathIndex = url.pathname.lastIndexOf("/trpc/");
	const procedure =
		trpcPathIndex === -1 ? "" : decodeURIComponent(url.pathname.slice(trpcPathIndex + 6));

	const input = url.searchParams.get("input");
	if (!input) {
		return null;
	}

	const envelope: unknown = JSON.parse(input);
	if (
		typeof envelope !== "object" ||
		envelope === null ||
		Array.isArray(envelope) ||
		!Object.hasOwn(envelope, "json") ||
		Object.keys(envelope).some((key) => key !== "json" && key !== "meta")
	) {
		return null;
	}

	const resourceInput = trpcTransformer.deserialize(
		envelope as Parameters<typeof trpcTransformer.deserialize>[0],
	);
	return subscriptionTicketScopeSchema.parse({ procedure, resource: resourceInput });
}
