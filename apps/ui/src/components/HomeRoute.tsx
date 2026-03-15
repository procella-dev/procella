import { useSession } from "@descope/react-sdk";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { HomePage } from "../pages/HomePage";
import { FullPageSpinner } from "./FullPageSpinner";

/**
 * Layout route that shows the landing page for unauthenticated users at "/",
 * or renders <Outlet /> (the protected dashboard) for authenticated users.
 * For non-root paths, unauthenticated users are redirected to /login.
 */
export function HomeRoute() {
	const { config, isLoading } = useAuthConfig();
	const location = useLocation();

	if (isLoading || !config) {
		return <FullPageSpinner />;
	}

	if (config.mode === "descope") {
		return <DescopeHomeRoute />;
	}

	// Dev mode: check localStorage token
	const token = localStorage.getItem("procella-token");
	if (!token) {
		if (location.pathname === "/") {
			return <HomePage />;
		}
		return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
	}

	return <Outlet />;
}

function DescopeHomeRoute() {
	const { isAuthenticated, isSessionLoading, sessionToken } = useSession();
	const location = useLocation();

	if (isSessionLoading) {
		return <FullPageSpinner />;
	}

	if (!isAuthenticated) {
		if (location.pathname === "/") {
			return <HomePage />;
		}
		return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
	}

	if (!sessionToken) {
		return <FullPageSpinner />;
	}

	return <Outlet />;
}
