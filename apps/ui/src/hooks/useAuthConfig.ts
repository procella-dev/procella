import { useEffect, useState } from "react";

export type AuthConfigResponse = { mode: "dev" } | { mode: "descope"; projectId: string };

let cachedConfig: AuthConfigResponse | null = null;
let fetchPromise: Promise<AuthConfigResponse> | null = null;

function fetchAuthConfig(): Promise<AuthConfigResponse> {
	if (cachedConfig) return Promise.resolve(cachedConfig);
	if (fetchPromise) return fetchPromise;

	fetchPromise = fetch("/api/auth/config")
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

export function useAuthConfig(): {
	config: AuthConfigResponse | null;
	isLoading: boolean;
} {
	const [config, setConfig] = useState<AuthConfigResponse | null>(cachedConfig);
	const [isLoading, setIsLoading] = useState(cachedConfig === null);

	useEffect(() => {
		if (cachedConfig) {
			setConfig(cachedConfig);
			setIsLoading(false);
			return;
		}

		fetchAuthConfig().then((data) => {
			setConfig(data);
			setIsLoading(false);
		});
	}, []);

	return { config, isLoading };
}
