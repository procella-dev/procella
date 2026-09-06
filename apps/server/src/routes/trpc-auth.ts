import type { AuthService } from "@procella/auth";
import type { Caller, SubscriptionTicketScope } from "@procella/types";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import type { Env } from "../types.js";

const stackResourceSchema = z.object({
	org: z.string().min(1),
	project: z.string().min(1),
	stack: z.string().min(1),
});
const updateResourceSchema = stackResourceSchema.extend({ updateId: z.string().min(1) });

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
	const trpcPathIndex = url.pathname.lastIndexOf("/trpc/");
	const procedure =
		trpcPathIndex === -1 ? "" : decodeURIComponent(url.pathname.slice(trpcPathIndex + 6));
	if (procedure !== "updates.onEvents" && procedure !== "updates.onStackActivity") {
		return null;
	}

	const input = url.searchParams.get("input");
	if (!input) {
		return null;
	}

	const parsed: unknown = JSON.parse(input);
	const resourceInput =
		typeof parsed === "object" && parsed !== null && "json" in parsed
			? (parsed as { json: unknown }).json
			: parsed;

	if (procedure === "updates.onEvents") {
		return {
			procedure,
			resource: updateResourceSchema.parse(resourceInput),
		};
	}

	return { procedure, resource: stackResourceSchema.parse(resourceInput) };
}
