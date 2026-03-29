import { useEffect, useState } from "react";
import { apiBase } from "../config";

export type AuthConfigResponse = { mode: "dev" } | { mode: "descope"; projectId: string };

let cachedConfig: AuthConfigResponse | null = null;
let fetchPromise: Promise<AuthConfigResponse> | null = null;

function fetchAuthConfig(): Promise<AuthConfigResponse> {
	if (cachedConfig) return Promise.resolve(cachedConfig);
	if (fetchPromise) return fetchPromise;

	fetchPromise = fetch(`${apiBase}/api/auth/config`)
		.then((res) => res.json() as Promise<AuthConfigResponse>)
		.then((data) => {
			cachedConfig = data;
			return data;
		});

	return fetchPromise;
}

export function getAuthConfig(): AuthConfigResponse | null {
	return cachedConfig;
}

export function useAuthConfig(options?: { enabled?: boolean }): {
	config: AuthConfigResponse | null;
	isLoading: boolean;
} {
	const enabled = options?.enabled ?? true;
	const [config, setConfig] = useState<AuthConfigResponse | null>(cachedConfig);
	const [isLoading, setIsLoading] = useState(enabled && cachedConfig === null);

	useEffect(() => {
		if (!enabled) return;

		if (cachedConfig) {
			setConfig(cachedConfig);
			setIsLoading(false);
			return;
		}

		fetchAuthConfig().then((data) => {
			setConfig(data);
			setIsLoading(false);
		});
	}, [enabled]);

	return { config, isLoading };
}
