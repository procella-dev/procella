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
	// Gate on isAuthenticated only — when the Descope project manages tokens in
	// HttpOnly cookies, sessionToken is never exposed to JS, so it must not be
	// part of the guard.
	const { isAuthenticated, isSessionLoading } = useSession();

	if (isSessionLoading) {
		return (
			<div className="min-h-screen bg-deep-sky flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-cloud/30 border-t-lightning" />
			</div>
		);
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ returnTo }} replace />;
	}

	return <Outlet />;
}
