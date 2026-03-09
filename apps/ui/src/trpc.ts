import { getSessionToken } from "@descope/react-sdk";
import type { AppRouter } from "@strata/api/src/router/index.js";
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { getAuthConfig } from "./hooks/useAuthConfig";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

function getAuthHeaders(): Record<string, string> {
	const config = getAuthConfig();

	if (config?.mode === "descope") {
		const token = getSessionToken();
		if (!token) return {};
		return { Authorization: `Bearer ${token}` };
	}

	const token = localStorage.getItem("strata-token") ?? "";
	if (!token) return {};
	return { Authorization: `token ${token}` };
}

export function createTRPCClient() {
	return createTRPCUntypedClient({
		links: [
			httpBatchLink({
				url: "/trpc",
				headers: getAuthHeaders,
				transformer: superjson,
			}),
		],
	});
}
