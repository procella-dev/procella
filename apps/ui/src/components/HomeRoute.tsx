import { useSession } from "@descope/react-sdk";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { HomePage } from "../pages/HomePage";
import { FullPageSpinner } from "./FullPageSpinner";

/**
 * Returns true when the app is running on the dashboard subdomain
 * (app.procella.cloud). On that domain unauthenticated visitors should go
 * straight to /login rather than seeing the marketing landing page.
 */
function isAppSubdomain(): boolean {
	return typeof window !== "undefined" && window.location.hostname.startsWith("app.");
}

/**
 * Layout route that shows the landing page for unauthenticated users at "/",
 * or renders <Outlet /> (the protected dashboard) for authenticated users.
 *
 * On the app subdomain (app.procella.cloud) the landing page is never shown;
 * unauthenticated visitors are redirected to /login instead.
 * For non-root paths, unauthenticated users are redirected to /login.
 */
export function HomeRoute() {
	const location = useLocation();
	const isLandingPage = location.pathname === "/" && !isAppSubdomain();
	const { config, isLoading } = useAuthConfig({ enabled: !isLandingPage });

	if (isLandingPage) {
		return <HomePage />;
	}

	if (isLoading || !config) {
		return <FullPageSpinner />;
	}

	if (config.mode === "descope") {
		return <DescopeHomeRoute />;
	}

	// Dev mode: check localStorage token
	const token = localStorage.getItem("procella-token");
	if (!token) {
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
		return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
	}

	if (!sessionToken) {
		return <FullPageSpinner />;
	}

	return <Outlet />;
}
