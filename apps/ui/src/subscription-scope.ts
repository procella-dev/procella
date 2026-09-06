import { type SubscriptionTicketScope, subscriptionTicketScopeSchema } from "@procella/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subscriptionScopeFromUrl(url: URL): SubscriptionTicketScope {
	const trpcPathIndex = url.pathname.lastIndexOf("/trpc/");
	const procedure =
		trpcPathIndex === -1 ? "" : decodeURIComponent(url.pathname.slice(trpcPathIndex + 6));

	const rawInput = url.searchParams.get("input");
	if (!rawInput) {
		throw new Error("Subscription URL is missing input");
	}

	const parsed: unknown = JSON.parse(rawInput);
	const input = isRecord(parsed) && "json" in parsed ? parsed.json : parsed;
	const scope = subscriptionTicketScopeSchema.safeParse({ procedure, resource: input });
	if (!scope.success) {
		throw new Error("Subscription URL has invalid scope");
	}

	return scope.data;
}
