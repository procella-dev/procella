import { getSessionToken } from "@descope/react-sdk";
import type { AppRouter } from "@procella/api/src/router/index.js";
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { apiBase } from "./config";
import { getAuthConfig } from "./hooks/useAuthConfig";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

function getAuthHeaders(): Record<string, string> {
	const config = getAuthConfig();

	if (config?.mode === "descope") {
		const token = getSessionToken();
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
			httpBatchLink({
				url: `${apiBase}/trpc`,
				headers: getAuthHeaders,
				transformer: superjson,
			}),
		],
	});
}
