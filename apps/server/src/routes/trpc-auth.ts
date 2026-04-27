import type { AuthService } from "@procella/auth";
import type { Caller } from "@procella/types";

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
