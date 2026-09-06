import type { SubscriptionTicketScope } from "@procella/types";

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
	if (
		!isRecord(input) ||
		typeof input.org !== "string" ||
		!input.org ||
		typeof input.project !== "string" ||
		!input.project ||
		typeof input.stack !== "string" ||
		!input.stack
	) {
		throw new Error("Subscription URL has invalid scope");
	}

	const resource = { org: input.org, project: input.project, stack: input.stack };
	if (procedure === "updates.onStackActivity") {
		return { procedure, resource };
	}
	if (procedure === "updates.onEvents" && typeof input.updateId === "string" && input.updateId) {
		return { procedure, resource: { ...resource, updateId: input.updateId } };
	}

	throw new Error("Subscription URL has invalid scope");
}
