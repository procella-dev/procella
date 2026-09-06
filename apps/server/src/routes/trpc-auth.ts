import type { AuthService } from "@procella/auth";
import type { Caller } from "@procella/types";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

export interface TrpcAuthDeps {
	auth: AuthService;
	verifySubscriptionTicket?: (ticket: string) => Promise<Caller>;
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
			return {
				caller: await deps.verifySubscriptionTicket(ticket),
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
