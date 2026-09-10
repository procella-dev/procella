import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const commandBarPath = resolve(import.meta.dir, "./components/CommandBar.tsx");
const trpcPath = resolve(import.meta.dir, "./trpc.ts");
const useAuthConfigPath = resolve(import.meta.dir, "./hooks/useAuthConfig.ts");

let currentCallerQuery: {
	data?: { tenantId: string; roles: string[] };
	isLoading: boolean;
	error: Error | null;
};
let sessionState: {
	sessionToken: string;
	claims: Record<string, unknown> | null;
	isAuthenticated: boolean;
};
let githubStatusQuery: {
	data?: {
		configured: boolean;
		connectAvailable: boolean;
		connectedLogin?: string | null;
		installations: Array<{
			id: string;
			tenantId: string;
			installationId: number;
			accountLogin: string;
			accountType: "Organization" | "User";
			repositorySelection: "all" | "selected";
			createdAt: Date;
			updatedAt: Date;
		}>;
	};
	isLoading: boolean;
	error: Error | null;
};
let connectTargetsQuery: {
	data?: {
		targets: Array<{
			accountLogin: string;
			accountType: "Organization" | "User";
			installationId: number | null;
			connected: boolean;
			claimedByOtherTenant: boolean;
		}>;
	};
	isLoading: boolean;
	error: Error | null;
};
let githubRepositoriesQuery: {
	data?: {
		repositories: Array<{
			id: number;
			name: string;
			fullName: string;
			ownerId: number;
			ownerLogin: string;
			private: boolean;
		}>;
	};
	isLoading: boolean;
	error: Error | null;
};
let oidcStatusQuery: {
	data?: {
		configured: boolean;
		githubActionsPolicies: Array<{
			id: string;
			displayName: string;
			active: boolean;
		}>;
	};
	isLoading: boolean;
	error: Error | null;
};
let oidcPoliciesQuery: {
	data?: Array<{
		id: string;
		displayName: string;
		issuer: string;
		maxExpiration: number;
		claimConditions: Record<string, string>;
		grantedRole: "viewer" | "member" | "admin";
		active: boolean;
	}>;
	isLoading: boolean;
	error: Error | null;
};
const startConnect = mock(async () => ({
	appId: "procella-github",
	tenantId: "tenant-from-server",
	redirectUrl: "https://app.example.test/settings/github/connected?state=signed-connect-state",
}));
const confirmConnect = mock(async () => ({ login: "octocat" }));
const outboundConnect = mock(async () => ({
	ok: true,
	data: { url: "https://github.com/login/oauth/authorize?state=descope" },
}));
const connectInstallation = mock(async () => ({
	installation: {
		installationId: 202,
		accountLogin: "acme",
		accountType: "Organization" as const,
		repositorySelection: "all" as const,
	},
}));
const createInstallationUrl = mock(async () => ({
	url: "https://github.com/apps/procella-bot/installations/new?state=install-state",
}));
const removeInstallation = mock(async () => ({ success: true }));
const statusRefetch = mock(async () => undefined);
const connectTargetsRefetch = mock(async () => undefined);
const oidcStatusRefetch = mock(async () => undefined);
const githubRepositoriesRefetch = mock(async () => undefined);
const oidcStatusInvalidate = mock(async () => undefined);
const oidcListPoliciesInvalidate = mock(async () => undefined);
const enableGitHubActions = mock(async () => ({
	created: true,
	policy: {
		id: "policy-1",
		displayName: "GitHub Actions · acme/infra",
		active: true,
	},
}));
const createOidcPolicy = mock(async () => ({ id: "policy-1" }));
const updateOidcPolicy = mock(async () => ({ id: "policy-1" }));
const deleteOidcPolicy = mock(async () => ({ success: true }));
const getSessionToken = mock(() => "must-not-be-read");
const getRefreshToken = mock(() => "must-not-be-read");

mock.module(useAuthConfigPath, () => ({
	useAuthConfig: () => ({
		config: { mode: "descope", projectId: "project-1" },
		isLoading: false,
	}),
}));

mock.module(trpcPath, () => ({
	trpc: {
		useUtils: () => ({
			oidc: {
				status: { invalidate: oidcStatusInvalidate },
				listPolicies: { invalidate: oidcListPoliciesInvalidate },
			},
		}),
		auth: {
			current: {
				useQuery: () => currentCallerQuery,
			},
		},
		github: {
			status: { useQuery: () => ({ ...githubStatusQuery, refetch: statusRefetch }) },
			startConnect: {
				useMutation: () => ({ mutateAsync: startConnect, isPending: false }),
			},
			confirmConnect: {
				useMutation: () => ({ mutateAsync: confirmConnect, isPending: false }),
			},
			connectTargets: {
				useQuery: (_input: undefined, options: { enabled: boolean }) => ({
					...(options.enabled
						? connectTargetsQuery
						: { data: undefined, isLoading: false, error: null }),
					refetch: connectTargetsRefetch,
				}),
			},
			repositories: {
				useQuery: (_input: { installationId: number }, options: { enabled: boolean }) => ({
					...(options.enabled
						? githubRepositoriesQuery
						: { data: undefined, isLoading: false, error: null }),
					refetch: githubRepositoriesRefetch,
				}),
			},
			connectInstallation: {
				useMutation: () => ({ mutateAsync: connectInstallation, isPending: false }),
			},
			createInstallationUrl: {
				useMutation: () => ({ mutateAsync: createInstallationUrl, isPending: false }),
			},
			removeInstallation: {
				useMutation: () => ({ mutateAsync: removeInstallation, isPending: false }),
			},
		},
		oidc: {
			status: {
				useQuery: () => ({ ...oidcStatusQuery, refetch: oidcStatusRefetch }),
			},
			enableGitHubActions: {
				useMutation: () => ({ mutateAsync: enableGitHubActions, isPending: false }),
			},
			listPolicies: {
				useQuery: () => oidcPoliciesQuery,
			},
			createPolicy: {
				useMutation: () => ({ mutateAsync: createOidcPolicy, isPending: false }),
			},
			updatePolicy: {
				useMutation: () => ({ mutateAsync: updateOidcPolicy, isPending: false }),
			},
			deletePolicy: {
				useMutation: () => ({ mutateAsync: deleteOidcPolicy, isPending: false }),
			},
		},
	},
}));

mock.module(commandBarPath, () => ({
	CommandBar: () => null,
	openCommandBar: () => {},
}));

mock.module("@descope/react-sdk", () => ({
	AuditManagement: () => null,
	AuthProvider: ({ children }: { children: ReactNode }) => children,
	RoleManagement: () => null,
	TenantProfile: () => null,
	UserManagement: ({ tenant }: { tenant: string }) =>
		createElement("div", { "data-testid": "user-management" }, tenant),
	useDescope: () => ({
		logout: async () => {},
		getSessionToken,
		getRefreshToken,
		outbound: { connect: outboundConnect },
	}),
	useSession: () => sessionState,
	useUser: () => ({ user: { name: "Admin User", email: "admin@example.com" } }),
}));

// Mock registration must precede application module evaluation in Bun tests.
const { Layout } = await import("./components/Layout");
const { Settings } = await import("./pages/Settings");
const { GitHubConnected } = await import("./pages/GitHubConnected");
const { ProcellaAuthProvider } = await import("./components/AuthProvider");
let dom: Window;

beforeEach(() => {
	dom = new Window({ url: "http://localhost/" });
	globalThis.window = dom as unknown as typeof globalThis.window;
	globalThis.document = dom.document as unknown as typeof globalThis.document;
	globalThis.localStorage = dom.localStorage;
	globalThis.sessionStorage = dom.sessionStorage;
	globalThis.HTMLElement = dom.HTMLElement;
	globalThis.Event = dom.Event as unknown as typeof globalThis.Event;
	globalThis.FormData = dom.FormData as unknown as typeof FormData;
	globalThis.MouseEvent = dom.MouseEvent as unknown as typeof globalThis.MouseEvent;
	currentCallerQuery = { data: undefined, isLoading: false, error: null };
	sessionState = {
		sessionToken: "",
		claims: { sub: "user-1", dct: "tenant-1" },
		isAuthenticated: true,
	};
	githubStatusQuery = {
		data: { configured: false, connectAvailable: false, installations: [] },
		isLoading: false,
		error: null,
	};
	connectTargetsQuery = { data: undefined, isLoading: false, error: null };
	githubRepositoriesQuery = { data: undefined, isLoading: false, error: null };
	oidcStatusQuery = {
		data: { configured: false, githubActionsPolicies: [] },
		isLoading: false,
		error: null,
	};
	oidcPoliciesQuery = { data: [], isLoading: false, error: null };
	startConnect.mockClear();
	startConnect.mockImplementation(async () => ({
		appId: "procella-github",
		tenantId: "tenant-from-server",
		redirectUrl: "https://app.example.test/settings/github/connected?state=signed-connect-state",
	}));
	confirmConnect.mockClear();
	confirmConnect.mockImplementation(async () => ({ login: "octocat" }));
	outboundConnect.mockClear();
	outboundConnect.mockImplementation(async () => ({
		ok: true,
		data: { url: "https://github.com/login/oauth/authorize?state=descope" },
	}));
	connectInstallation.mockClear();
	connectInstallation.mockImplementation(async () => ({
		installation: {
			installationId: 202,
			accountLogin: "acme",
			accountType: "Organization" as const,
			repositorySelection: "all" as const,
		},
	}));
	createInstallationUrl.mockClear();
	createInstallationUrl.mockImplementation(async () => ({
		url: "https://github.com/apps/procella-bot/installations/new?state=install-state",
	}));
	removeInstallation.mockClear();
	statusRefetch.mockClear();
	connectTargetsRefetch.mockClear();
	oidcStatusRefetch.mockClear();
	githubRepositoriesRefetch.mockClear();
	oidcStatusInvalidate.mockClear();
	oidcListPoliciesInvalidate.mockClear();
	createOidcPolicy.mockClear();
	updateOidcPolicy.mockClear();
	deleteOidcPolicy.mockClear();
	enableGitHubActions.mockClear();
	getSessionToken.mockClear();
	getRefreshToken.mockClear();
});

afterEach(async () => {
	cleanup();
	await dom.happyDOM.close();
});

describe("session authorization cache", () => {
	test("resets cached server data when Descope session claims change", async () => {
		const queryClient = new QueryClient();
		const resetQueries = mock(async () => undefined);
		queryClient.resetQueries = resetQueries as typeof queryClient.resetQueries;
		const page = render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(ProcellaAuthProvider, null, createElement("div")),
			),
		);
		expect(resetQueries).toHaveBeenCalledTimes(0);

		sessionState = {
			...sessionState,
			claims: { sub: "user-2", dct: "tenant-1" },
		};
		page.rerender(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(ProcellaAuthProvider, null, createElement("div")),
			),
		);

		await waitFor(() => expect(resetQueries).toHaveBeenCalledTimes(1));
	});
});

describe("Layout authorization", () => {
	test("shows Settings for an admin returned by the server", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(MemoryRouter, null, createElement(Layout)));

		expect(page.getAllByText("Settings")).not.toHaveLength(0);
	});

	test("hides Settings for a non-admin returned by the server", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(MemoryRouter, null, createElement(Layout)));

		expect(page.queryByText("Settings")).toBeNull();
	});
});

describe("Settings authorization", () => {
	test("renders admin settings from the server-authenticated caller", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin", "member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(Settings));

		expect(page.getByText("OIDC")).toBeTruthy();
		expect(page.getByTestId("user-management").textContent).toBe("tenant-from-server");
	});

	test("keeps non-admin callers out of settings", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(Settings));

		expect(page.getByText("Admin access required")).toBeTruthy();
	});

	test("authorizes with GitHub via a single Continue action, then completes via the browser's own outbound.connect without reading or storing anything", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		let page = render(createElement(Settings));
		expect(page.getByText("GitHub App is not configured")).toBeTruthy();
		page.unmount();

		githubStatusQuery = {
			data: { configured: true, connectAvailable: true, connectedLogin: null, installations: [] },
			isLoading: false,
			error: null,
		};
		page = render(createElement(Settings));
		// No free-text account field remains anywhere in the disconnected state.
		expect(page.queryByLabelText("GitHub account")).toBeNull();
		fireEvent.click(page.getByRole("button", { name: "Continue with GitHub" }));
		await waitFor(() => expect(startConnect).toHaveBeenCalledWith({}));

		// The server response carries no token — only the outbound app id, the
		// tenant, and a server-built redirect URL — and the browser's own
		// cookie-authenticated SDK performs the outbound connect with no token
		// argument of its own.
		await waitFor(() =>
			expect(outboundConnect).toHaveBeenCalledWith("procella-github", {
				redirectUrl:
					"https://app.example.test/settings/github/connected?state=signed-connect-state",
				tenantId: "tenant-from-server",
			}),
		);
		expect(outboundConnect.mock.calls[0]).toHaveLength(2);
		await waitFor(() =>
			expect(dom.location.href).toBe("https://github.com/login/oauth/authorize?state=descope"),
		);

		// Cookie mode: no session or refresh token is read, and the browser keeps
		// no setup state of its own: the transaction lives on the server and in
		// the HttpOnly nonce cookie.
		expect(getSessionToken).not.toHaveBeenCalled();
		expect(getRefreshToken).not.toHaveBeenCalled();
		expect(sessionStorage.length).toBe(0);
		expect(localStorage.length).toBe(0);
		expect(confirmConnect).not.toHaveBeenCalled();
	});

	test("keeps the Continue with GitHub control disabled until outbound connect settles, and drops a reentrant click", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: { configured: true, connectAvailable: true, connectedLogin: null, installations: [] },
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";
		const connect = Promise.withResolvers<{ ok: boolean }>();
		outboundConnect.mockImplementationOnce(() => connect.promise);

		const page = render(createElement(Settings));
		// Two clicks dispatched inside one `act` land before React commits the
		// disabled state, so this exercises the in-handler reentrancy guard
		// itself rather than the disabled attribute that guards real users.
		act(() => {
			fireEvent.click(page.getByRole("button", { name: "Continue with GitHub" }));
			fireEvent.click(page.getByRole("button", { name: "Continue with GitHub" }));
		});

		await waitFor(() => expect(outboundConnect).toHaveBeenCalledTimes(1));
		expect(startConnect).toHaveBeenCalledTimes(1);
		const pendingButton = page.getByRole("button", {
			name: "Opening GitHub…",
		}) as HTMLButtonElement;
		expect(pendingButton.disabled).toBe(true);

		const ordinaryPageShow = new dom.Event("pageshow");
		Object.defineProperty(ordinaryPageShow, "persisted", { value: false });
		act(() => dom.dispatchEvent(ordinaryPageShow));
		expect(pendingButton.disabled).toBe(true);

		const restoredPageShow = new dom.Event("pageshow");
		Object.defineProperty(restoredPageShow, "persisted", { value: true });
		act(() => dom.dispatchEvent(restoredPageShow));
		await waitFor(() =>
			expect(
				(page.getByRole("button", { name: "Continue with GitHub" }) as HTMLButtonElement).disabled,
			).toBe(false),
		);
		expect(startConnect).toHaveBeenCalledTimes(1);
		expect(outboundConnect).toHaveBeenCalledTimes(1);

		act(() => connect.resolve({ ok: false }));
		await waitFor(() => expect(page.getByText("Unable to start GitHub setup")).toBeTruthy());
		expect(
			(page.getByRole("button", { name: "Continue with GitHub" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	test("rejects an authorization URL outside GitHub's authorize endpoint and never navigates", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: { configured: true, connectAvailable: true, connectedLogin: null, installations: [] },
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";
		outboundConnect.mockImplementationOnce(async () => ({
			ok: true,
			data: { url: "https://evil.example/login/oauth/authorize" },
		}));

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Continue with GitHub" }));

		await waitFor(() => expect(outboundConnect).toHaveBeenCalled());
		await waitFor(() => expect(page.getByText("Unable to start GitHub setup")).toBeTruthy());
		expect(dom.location.href).not.toContain("evil.example");
	});

	test("reports an unsuccessful outbound.connect response instead of navigating", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: { configured: true, connectAvailable: true, connectedLogin: null, installations: [] },
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";
		outboundConnect.mockImplementationOnce(async () => ({ ok: false }));

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Continue with GitHub" }));

		await waitFor(() => expect(outboundConnect).toHaveBeenCalled());
		await waitFor(() => expect(page.getByText("Unable to start GitHub setup")).toBeTruthy());
	});

	test("resumes the authorization handoff from the signed callback state and lands back on settings", async () => {
		dom.location.href = "http://localhost/settings/github/connected?state=signed-connect-state";

		render(createElement(GitHubConnected));

		await waitFor(() =>
			expect(confirmConnect).toHaveBeenCalledWith({ state: "signed-connect-state" }),
		);
		await waitFor(() =>
			expect(dom.location.href).toBe("http://localhost/settings?github=connected#github"),
		);
		expect(getSessionToken).not.toHaveBeenCalled();
		expect(getRefreshToken).not.toHaveBeenCalled();
		expect(sessionStorage.length).toBe(0);
	});

	test("sends the browser back to settings when the callback carries no transaction", async () => {
		dom.location.href = "http://localhost/settings/github/connected";

		render(createElement(GitHubConnected));

		await waitFor(() => expect(dom.location.href).toContain("reason=invalid_state"));
		expect(confirmConnect).not.toHaveBeenCalled();
	});

	test("lists connect targets once a GitHub identity is confirmed: Connect binds an unclaimed installation and refetches", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: {
				targets: [
					{
						accountLogin: "acme",
						accountType: "Organization",
						installationId: 202,
						connected: false,
						claimedByOtherTenant: false,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		expect(page.getByText(/Connected as GitHub user/)).toBeTruthy();
		expect(page.getByText("acme")).toBeTruthy();
		fireEvent.click(page.getByRole("button", { name: "Connect" }));

		await waitFor(() => expect(connectInstallation).toHaveBeenCalledWith({ installationId: 202 }));
		await waitFor(() => expect(statusRefetch).toHaveBeenCalled());
		await waitFor(() => expect(connectTargetsRefetch).toHaveBeenCalled());
	});

	test("Install issues a fresh App installation link and navigates only when it points at GitHub's app install endpoint", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: {
				targets: [
					{
						accountLogin: "acme",
						accountType: "Organization",
						installationId: null,
						connected: false,
						claimedByOtherTenant: false,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Install" }));

		await waitFor(() =>
			expect(createInstallationUrl).toHaveBeenCalledWith({ accountLogin: "acme" }),
		);
		await waitFor(() =>
			expect(dom.location.href).toBe(
				"https://github.com/apps/procella-bot/installations/new?state=install-state",
			),
		);
	});

	test("offers a GitHub-side account picker for organizations the list cannot enumerate", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = { data: { targets: [] }, isLoading: false, error: null };
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Choose an account on GitHub" }));

		// No account is sent: an organization without the App installed is
		// invisible to the vaulted token, so GitHub picks and the callback
		// derives it.
		await waitFor(() => expect(createInstallationUrl).toHaveBeenCalledWith({}));
		await waitFor(() =>
			expect(dom.location.href).toBe(
				"https://github.com/apps/procella-bot/installations/new?state=install-state",
			),
		);
	});

	test("refuses a non-GitHub App install URL without navigating", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: {
				targets: [
					{
						accountLogin: "acme",
						accountType: "Organization",
						installationId: null,
						connected: false,
						claimedByOtherTenant: false,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";
		createInstallationUrl.mockImplementationOnce(async () => ({
			url: "https://evil.example/apps/x",
		}));

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Install" }));

		await waitFor(() => expect(createInstallationUrl).toHaveBeenCalled());
		await waitFor(() =>
			expect(page.getByText("Unable to start GitHub App installation")).toBeTruthy(),
		);
		expect(dom.location.href).not.toContain("evil.example");
	});

	test("disables Connect and explains a target already claimed by another tenant", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: {
				targets: [
					{
						accountLogin: "other-org",
						accountType: "Organization",
						installationId: 303,
						connected: false,
						claimedByOtherTenant: true,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		const button = page.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(page.getByText(/already connected to a different tenant/i)).toBeTruthy();

		fireEvent.click(button);
		expect(connectInstallation).not.toHaveBeenCalled();
	});

	test("explains an empty connect target list instead of rendering nothing", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = { data: { targets: [] }, isLoading: false, error: null };
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		expect(page.getByText("No GitHub accounts to connect")).toBeTruthy();
	});

	test("lets a confirmed identity reauthorize as a different GitHub account with nothing installed", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = { data: { targets: [] }, isLoading: false, error: null };
		dom.location.hash = "github";

		const page = render(createElement(Settings));

		// Authorizing the wrong login must not be a dead end: no installation
		// exists, so no Disconnect is rendered to clear the connection.
		fireEvent.click(page.getByRole("button", { name: "Change GitHub account" }));
		await waitFor(() => expect(startConnect).toHaveBeenCalledWith({}));
		await waitFor(() => expect(outboundConnect).toHaveBeenCalledTimes(1));
		expect(dom.location.href).toContain("github.com/login/oauth/authorize");
	});

	test("surfaces a connect target query failure through the action error banner", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: undefined,
			isLoading: false,
			error: new Error("Unable to load GitHub accounts"),
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		expect(page.getByText("Unable to load GitHub accounts")).toBeTruthy();
	});

	test("shows callback success and existing installations, with no per-installation reverify action", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [
					{
						id: "row-1",
						tenantId: "tenant-from-server",
						installationId: 101,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "selected",
						createdAt: new Date("2026-09-04T00:00:00Z"),
						updatedAt: new Date("2026-09-04T00:00:00Z"),
					},
				],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = {
			data: {
				targets: [
					{
						accountLogin: "acme",
						accountType: "Organization",
						installationId: 101,
						connected: true,
						claimedByOtherTenant: false,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		oidcStatusQuery = {
			data: {
				configured: true,
				githubActionsPolicies: [
					{
						id: "policy-1",
						displayName: "GitHub Actions · acme/infra",
						active: true,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.href = "http://localhost/settings?github=connected#github";

		const page = render(createElement(Settings));
		expect(page.getByText("GitHub connected successfully.")).toBeTruthy();
		expect(page.getByText("Selected repositories")).toBeTruthy();
		expect(page.queryByRole("button", { name: "Configure & Verify" })).toBeNull();
		expect(
			page.getByText(/Enabled:.*GitHub Actions · acme\/infra/, { selector: "li" }),
		).toBeTruthy();
		expect(page.getByRole("button", { name: "Add Actions OIDC repository" })).toBeTruthy();
	});

	test("adds GitHub Actions OIDC for another repository on an installed App", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [
					{
						id: "row-1",
						tenantId: "tenant-from-server",
						installationId: 101,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "selected",
						createdAt: new Date("2026-09-04T00:00:00Z"),
						updatedAt: new Date("2026-09-04T00:00:00Z"),
					},
				],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = { data: { targets: [] }, isLoading: false, error: null };
		oidcStatusQuery = {
			data: {
				configured: true,
				githubActionsPolicies: [
					{ id: "policy-1", displayName: "GitHub Actions · acme/infra", active: true },
				],
			},
			isLoading: false,
			error: null,
		};
		githubRepositoriesQuery = {
			data: {
				repositories: [
					{
						id: 13579,
						name: "service",
						fullName: "acme/service",
						ownerId: 12345,
						ownerLogin: "acme",
						private: true,
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Add Actions OIDC repository" }));
		expect(page.getByRole("option", { name: "acme/service · private" })).toBeTruthy();
		fireEvent.click(page.getByRole("button", { name: "Enable OIDC" }));

		await waitFor(() =>
			expect(enableGitHubActions).toHaveBeenCalledWith({
				installationId: 101,
				repositoryId: 13579,
			}),
		);
		await waitFor(() => expect(oidcStatusInvalidate).toHaveBeenCalled());
		await waitFor(() => expect(oidcListPoliciesInvalidate).toHaveBeenCalled());
	});

	test("keeps retry and cancel available when repository loading fails", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: true,
				connectedLogin: "octocat",
				installations: [
					{
						id: "row-1",
						tenantId: "tenant-from-server",
						installationId: 101,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "selected",
						createdAt: new Date("2026-09-04T00:00:00Z"),
						updatedAt: new Date("2026-09-04T00:00:00Z"),
					},
				],
			},
			isLoading: false,
			error: null,
		};
		connectTargetsQuery = { data: { targets: [] }, isLoading: false, error: null };
		oidcStatusQuery = {
			data: { configured: true, githubActionsPolicies: [] },
			isLoading: false,
			error: null,
		};
		githubRepositoriesQuery = {
			data: {
				repositories: [
					{
						id: 67890,
						name: "infra",
						fullName: "acme/infra",
						ownerId: 12345,
						ownerLogin: "acme",
						private: true,
					},
				],
			},
			isLoading: false,
			error: new Error("GitHub repositories could not be loaded"),
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Enable Actions OIDC" }));
		expect(page.getByRole("button", { name: "Cancel" })).toBeTruthy();
		expect(page.queryByRole("button", { name: "Enable OIDC" })).toBeNull();
		fireEvent.click(page.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(githubRepositoriesRefetch).toHaveBeenCalled());

		fireEvent.click(page.getByRole("button", { name: "Cancel" }));
		expect(page.queryByText("GitHub repositories could not be loaded")).toBeNull();
	});

	test("advanced policy mutations invalidate both OIDC views", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		oidcPoliciesQuery = {
			data: [
				{
					id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
					displayName: "GitHub Actions · acme/infra",
					issuer: "https://token.actions.githubusercontent.com",
					maxExpiration: 7200,
					claimConditions: {
						repository_owner_id: "12345",
						repository_id: "67890",
					},
					grantedRole: "member",
					active: true,
				},
			],
			isLoading: false,
			error: null,
		};
		dom.location.hash = "oidc";

		const page = render(createElement(Settings));
		fireEvent.click(page.getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(updateOidcPolicy).toHaveBeenCalled());
		await waitFor(() => expect(oidcStatusInvalidate).toHaveBeenCalled());
		await waitFor(() => expect(oidcListPoliciesInvalidate).toHaveBeenCalled());

		oidcStatusInvalidate.mockClear();
		oidcListPoliciesInvalidate.mockClear();
		fireEvent.click(page.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteOidcPolicy).toHaveBeenCalled());
		await waitFor(() => expect(oidcStatusInvalidate).toHaveBeenCalled());
		await waitFor(() => expect(oidcListPoliciesInvalidate).toHaveBeenCalled());
	});

	test("explains an unavailable outbound connection and hides every connect action", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				connectAvailable: false,
				connectedLogin: null,
				installations: [],
			},
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		const page = render(createElement(Settings));
		expect(page.getByText(/no Descope Outbound App connection/)).toBeTruthy();
		expect(page.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
		expect(page.queryByLabelText("GitHub account")).toBeNull();
	});

	test("explains each GitHub callback failure reason", () => {
		const reasons = [
			["expired_state", "The GitHub setup link expired. Start the connection again."],
			[
				"authorization_required",
				"Your GitHub user must own the account or be an active organization administrator.",
			],
			["authorization_unavailable", "GitHub user verification is not configured on this server."],
			[
				"unauthorized_account",
				"GitHub returned an installation for a different account. Start the connection again.",
			],
			[
				"unsupported_setup_action",
				"GitHub returned an unsupported setup callback. Start the connection again.",
			],
			[
				"invalid_state",
				"This GitHub connection could not be verified. Start the connection again.",
			],
			["replayed_state", "This GitHub setup link was already used. Start the connection again."],
		] as const;

		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: { configured: true, connectAvailable: true, connectedLogin: null, installations: [] },
			isLoading: false,
			error: null,
		};

		for (const [reason, message] of reasons) {
			dom.location.href = `http://localhost/settings?github=error&reason=${reason}#github`;
			const page = render(createElement(Settings));
			expect(page.getByText(message)).toBeTruthy();
			page.unmount();
		}
	});
});
