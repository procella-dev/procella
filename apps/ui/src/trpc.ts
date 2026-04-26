import type { AppRouter } from "@procella/api/src/router/index.js";
import {
	createTRPCUntypedClient,
	httpBatchLink,
	httpSubscriptionLink,
	splitLink,
} from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { getStoredDescopeSessionToken } from "./auth/sessionToken";
import { apiBase } from "./config";
import { getAuthConfig } from "./hooks/useAuthConfig";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function getAuthHeaders(): Record<string, string> {
	const config = getAuthConfig();

	if (config?.mode === "descope") {
		const token = getStoredDescopeSessionToken();
		if (!token) return {};
		return { Authorization: `Bearer ${token}` };
	}

	const token = localStorage.getItem("procella-token") ?? "";
	if (!token) return {};
	return { Authorization: `token ${token}` };
}

export function createTRPCClient() {
	return createTRPCUntypedClient({
		links: [
			splitLink({
				condition: (op) => op.type === "subscription",
				true: httpSubscriptionLink({
					url: `${apiBase}/trpc`,
					connectionParams: async () => {
						const headers = getAuthHeaders();
						return headers.Authorization ? { authorization: headers.Authorization } : {};
					},
					transformer: superjson,
				}),
				false: httpBatchLink({
					url: `${apiBase}/trpc`,
					headers: getAuthHeaders,
					transformer: superjson,
				}),
			}),
		],
	});
}
