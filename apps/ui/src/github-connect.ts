// Non-secret handoff state for the GitHub connect flow.
//
// The outbound connect leaves the dashboard, so the account the admin typed has
// to survive a full-page navigation. Only the account login is kept, it is
// re-validated on both write and read, and it lives in sessionStorage so it
// dies with the tab. No token or session material is ever stored here.

export const GITHUB_CONNECT_ACCOUNT_KEY = "procella-github-connect-account";

const GITHUB_ACCOUNT_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/;

export function rememberGitHubConnectAccount(accountLogin: string): string | null {
	const candidate = accountLogin.trim();
	if (!GITHUB_ACCOUNT_PATTERN.test(candidate)) return null;
	sessionStorage.setItem(GITHUB_CONNECT_ACCOUNT_KEY, candidate);
	return candidate;
}

export function readGitHubConnectAccount(): string | null {
	const stored = sessionStorage.getItem(GITHUB_CONNECT_ACCOUNT_KEY);
	return stored && GITHUB_ACCOUNT_PATTERN.test(stored) ? stored : null;
}

export function clearGitHubConnectAccount(): void {
	sessionStorage.removeItem(GITHUB_CONNECT_ACCOUNT_KEY);
}
