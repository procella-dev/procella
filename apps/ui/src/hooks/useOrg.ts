import { getCurrentTenant, useSession } from "@descope/react-sdk";
import { trpc } from "../trpc";
import { useAuthConfig } from "./useAuthConfig";

/**
 * Returns the current organization slug for use in tRPC calls that require `org`.
 *
 * - In descope mode: uses the tenant ID from the JWT (which maps to orgSlug on the server).
 * - In dev mode: reads the orgName from the first stack in the stacks list,
 *   falling back to "dev-org" (the default PROCELLA_DEV_ORG_LOGIN).
 */
export function useOrg(): { org: string; isLoading: boolean } {
	const { config } = useAuthConfig();
	const { sessionToken } = useSession();

	const isDescopeMode = config?.mode === "descope";
	const descopeTenantId = isDescopeMode && sessionToken ? getCurrentTenant(sessionToken) : "";

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
