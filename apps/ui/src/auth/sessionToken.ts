export const DESCOPE_SESSION_TOKEN_STORAGE_KEY = "procella-descope-session-token";

export function getStoredDescopeSessionToken(): string {
	return localStorage.getItem(DESCOPE_SESSION_TOKEN_STORAGE_KEY) ?? "";
}

export function setStoredDescopeSessionToken(token: string | null | undefined): void {
	if (token) {
		localStorage.setItem(DESCOPE_SESSION_TOKEN_STORAGE_KEY, token);
		return;
	}

	localStorage.removeItem(DESCOPE_SESSION_TOKEN_STORAGE_KEY);
}

// Session claims mirror — populated by the AuthProvider bridge. Claims stay
// available even when Descope manages the JWT in an HttpOnly cookie (where
// the raw token above is empty), so non-hook code (e.g. useOrg) can derive
// tenant/roles without decoding a JWT.
export const DESCOPE_SESSION_CLAIMS_STORAGE_KEY = "procella-descope-session-claims";

export function getStoredDescopeSessionClaims(): Record<string, unknown> | null {
	const raw = localStorage.getItem(DESCOPE_SESSION_CLAIMS_STORAGE_KEY);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function setStoredDescopeSessionClaims(claims: object | null | undefined): void {
	if (claims && Object.keys(claims).length > 0) {
		localStorage.setItem(DESCOPE_SESSION_CLAIMS_STORAGE_KEY, JSON.stringify(claims));
		return;
	}

	localStorage.removeItem(DESCOPE_SESSION_CLAIMS_STORAGE_KEY);
}
