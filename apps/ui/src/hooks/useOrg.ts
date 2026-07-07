import { tenantFromClaims } from "../auth/claims";
import { getStoredDescopeSessionClaims } from "../auth/sessionToken";
import { trpc } from "../trpc";
import { useAuthConfig } from "./useAuthConfig";

/**
 * Returns the current organization slug for use in tRPC calls that require `org`.
 *
 * - In descope mode: uses the tenant ID from the session claims (which maps to orgSlug on the server).
 * - In dev mode: reads the orgName from the first stack in the stacks list,
 *   falling back to "dev-org" (the default PROCELLA_DEV_ORG_LOGIN).
 */
export function useOrg(): { org: string; isLoading: boolean } {
	const { config } = useAuthConfig();

	const isDescopeMode = config?.mode === "descope";
	// Claims are mirrored to localStorage by the AuthProvider bridge and remain
	// available even when the session JWT lives in an HttpOnly cookie.
	const descopeTenantId = isDescopeMode ? tenantFromClaims(getStoredDescopeSessionClaims()) : "";

	const { data: stacksData, isLoading: stacksLoading } = trpc.stacks.list.useQuery(undefined, {
		enabled: !isDescopeMode,
		refetchOnWindowFocus: false,
	});

	if (isDescopeMode) {
		return { org: descopeTenantId || "", isLoading: !descopeTenantId };
	}

	const orgFromStacks = stacksData?.stacks?.[0]?.orgName ?? "dev-org";
	return { org: orgFromStacks, isLoading: stacksLoading };
}
