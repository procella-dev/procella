import type { Role } from "@procella/types";

export interface OidcTrustPolicy {
	id: string;
	tenantId: string;
	orgSlug: string;
	provider: string;
	displayName: string;
	issuer: string;
	maxExpiration: number;
	claimConditions: Record<string, string>;
	grantedRole: Role;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface TokenExchangeRequest {
	audience: string;
	grantType: string;
	subjectToken: string;
	subjectTokenType: string;
	requestedTokenType: string;
	scope: string;
	expiration?: number;
}

export interface TokenExchangeResponse {
	access_token: string;
	issued_token_type: string;
	token_type: string;
	expires_in: number;
	scope: string;
}

export type { WorkloadIdentity } from "@procella/types";

export interface OidcService {
	exchange(req: TokenExchangeRequest): Promise<TokenExchangeResponse>;
}

export interface JwksValidator {
	verify(
		jwt: string,
		expectedIssuer: string,
		expectedAudience: string,
	): Promise<Record<string, unknown>>;
	dispose(): void;
}

export interface TrustPolicyRepository {
	findByOrgSlug(orgSlug: string): Promise<OidcTrustPolicy[]>;
	create(policy: Omit<OidcTrustPolicy, "id" | "createdAt" | "updatedAt">): Promise<OidcTrustPolicy>;
	update(
		id: string,
		tenantId: string,
		patch: Partial<
			Pick<
				OidcTrustPolicy,
				"displayName" | "claimConditions" | "grantedRole" | "maxExpiration" | "active"
			>
		>,
	): Promise<OidcTrustPolicy>;
	delete(id: string, tenantId: string): Promise<void>;
}
