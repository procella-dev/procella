import { AuthProvider, useSession } from "@descope/react-sdk";
import { type ReactNode, useEffect } from "react";
import { setStoredDescopeSessionToken } from "../auth/sessionToken";
import { useAuthConfig } from "../hooks/useAuthConfig";

function DescopeSessionTokenBridge() {
	const { sessionToken } = useSession();

	useEffect(() => {
		setStoredDescopeSessionToken(sessionToken);
	}, [sessionToken]);

	return null;
}

export function ProcellaAuthProvider({ children }: { children: ReactNode }) {
	const { config, isLoading } = useAuthConfig();

	// Side effects (localStorage / module-level token store) MUST run after
	// commit, not during render — React StrictMode + concurrent rendering
	// will run render multiple times and discard results.
	useEffect(() => {
		if (!config) return;
		if (config.mode === "descope") {
			localStorage.removeItem("procella-token");
		} else {
			setStoredDescopeSessionToken(null);
		}
	}, [config]);

	if (isLoading || !config) {
		return (
			<div className="min-h-screen bg-deep-sky flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-cloud/30 border-t-lightning" />
			</div>
		);
	}

	if (config.mode === "descope") {
		return (
			<AuthProvider projectId={config.projectId}>
				<DescopeSessionTokenBridge />
				{children}
			</AuthProvider>
		);
	}

	return <>{children}</>;
}
