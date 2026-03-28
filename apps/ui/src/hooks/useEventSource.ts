import { getSessionToken } from "@descope/react-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc";
import { getAuthConfig } from "./useAuthConfig";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export function useEventSource(updateId: string | undefined) {
	const [status, setStatus] = useState<ConnectionStatus>("disconnected");
	const queryClient = useQueryClient();
	const retryCount = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!updateId) return;

		let es: EventSource | null = null;

		const connect = () => {
			const config = getAuthConfig();
			const authToken =
				config?.mode === "descope"
					? (() => {
							const token = getSessionToken();
							return token ? `Bearer ${token}` : "";
						})()
					: (() => {
							const token = localStorage.getItem("procella-token") ?? "";
							return token ? `token ${token}` : "";
						})();
			const url = `/api/updates/${updateId}/stream?token=${encodeURIComponent(authToken)}`;
			es = new EventSource(url);

			es.onopen = () => {
				setStatus("connected");
				retryCount.current = 0;
			};

			es.onmessage = () => {
				queryClient.invalidateQueries({
					queryKey: getQueryKey(trpc.events.list, undefined, "query"),
				});
			};

			es.onerror = () => {
				es?.close();
				setStatus("reconnecting");
				const delay = Math.min(1000 * 2 ** retryCount.current, 30000);
				retryCount.current += 1;
				timerRef.current = setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			es?.close();
			setStatus("disconnected");
		};
	}, [updateId, queryClient]);

	return status;
}
