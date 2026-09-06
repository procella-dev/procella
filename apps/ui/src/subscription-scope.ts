import type { SubscriptionTicketScope } from "@procella/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subscriptionScopeFromUrl(url: URL): SubscriptionTicketScope {
	const trpcPathIndex = url.pathname.lastIndexOf("/trpc/");
	const procedure =
		trpcPathIndex === -1 ? "" : decodeURIComponent(url.pathname.slice(trpcPathIndex + 6));
	if (procedure !== "updates.onEvents" && procedure !== "updates.onStackActivity") {
		throw new Error("Subscription URL has unsupported procedure");
	}

	const rawInput = url.searchParams.get("input");
	if (!rawInput) {
		throw new Error("Subscription URL is missing input");
	}

	const parsed: unknown = JSON.parse(rawInput);
	const input = isRecord(parsed) && "json" in parsed ? parsed.json : parsed;
	if (
		!isRecord(input) ||
		typeof input.org !== "string" ||
		typeof input.project !== "string" ||
		typeof input.stack !== "string"
	) {
		throw new Error("Subscription URL has invalid resource input");
	}

	const resource = {
		org: input.org,
		project: input.project,
		stack: input.stack,
	};
	if (procedure === "updates.onEvents") {
		if (typeof input.updateId !== "string") {
			throw new Error("Subscription URL has invalid resource input");
		}
		return { procedure, resource: { ...resource, updateId: input.updateId } };
	}

	return { procedure, resource };
}
