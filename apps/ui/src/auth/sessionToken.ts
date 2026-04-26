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
