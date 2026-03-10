import { useSession } from "@descope/react-sdk";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function ProtectedRoute() {
	const { config } = useAuthConfig();
	const location = useLocation();

	if (!config) return null;

	if (config.mode === "descope") {
		return <DescopeGuard returnTo={location.pathname} />;
	}

	const token = localStorage.getItem("procella-token");
	if (!token) {
		return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
	}

	return <Outlet />;
}

function DescopeGuard({ returnTo }: { returnTo: string }) {
	const { isAuthenticated, isSessionLoading, sessionToken } = useSession();

	if (isSessionLoading) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
			</div>
		);
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ returnTo }} replace />;
	}

	if (!sessionToken) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
			</div>
		);
	}

	return <Outlet />;
}
