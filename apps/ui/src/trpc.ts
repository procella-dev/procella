import type { AppRouter } from "@strata/api/src/router/index.js";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";

export const trpc = createTRPCReact<AppRouter>();

function getAuthHeaders(): Record<string, string> {
	const token = localStorage.getItem("strata-token") ?? "";
	if (!token) return {};
	return { Authorization: `token ${token}` };
}

export function createTRPCClient() {
	return trpc.createClient({
		links: [
			httpBatchLink({
				url: "/trpc",
				headers: getAuthHeaders,
				transformer: superjson,
			}),
		],
	});
}
