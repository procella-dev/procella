import { AuthProvider } from "@descope/react-sdk";
import type { ReactNode } from "react";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function ProcellaAuthProvider({ children }: { children: ReactNode }) {
	const { config, isLoading } = useAuthConfig();

	if (isLoading || !config) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
			</div>
		);
	}

	if (config.mode === "descope") {
		localStorage.removeItem("procella-token");
		return <AuthProvider projectId={config.projectId}>{children}</AuthProvider>;
	}

	return <>{children}</>;
}
