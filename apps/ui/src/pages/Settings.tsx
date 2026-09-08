import {
	AuditManagement,
	RoleManagement,
	TenantProfile,
	UserManagement,
	useDescope,
} from "@descope/react-sdk";
import { useEffect, useRef, useState } from "react";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { trpc } from "../trpc";

type SettingsTab = "users" | "roles" | "audit" | "tenant" | "github" | "oidc";

function getTab(): SettingsTab {
	const hash = window.location.hash.slice(1);
	if (
		hash === "roles" ||
		hash === "audit" ||
		hash === "tenant" ||
		hash === "github" ||
		hash === "oidc"
	)
		return hash;
	return "users";
}

export function Settings() {
	const { config } = useAuthConfig();
	const {
		data: caller,
		isLoading: isCallerLoading,
		error: callerError,
	} = trpc.auth.current.useQuery(undefined, { enabled: config?.mode === "descope" });
	const [tab, setTab] = useState<SettingsTab>(getTab);

	useEffect(() => {
		const onHashChange = () => setTab(getTab());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	if (config?.mode !== "descope") return null;

	const tenantId = caller?.tenantId ?? "";
	const isAdmin = caller?.roles.includes("admin") ?? false;

	const selectTab = (t: SettingsTab) => {
		window.location.hash = t;
		setTab(t);
	};

	if (isCallerLoading) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-cloud">Loading session…</p>
				</div>
			</div>
		);
	}

	if (callerError || !caller) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-mist/80 font-medium">Unable to verify access</p>
					<p className="text-cloud text-sm mt-1">Refresh the page and sign in again.</p>
				</div>
			</div>
		);
	}

	if (!isAdmin) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-mist/80 font-medium">Admin access required</p>
					<p className="text-cloud text-sm mt-1">
						Your account does not have the admin role for this organization.
					</p>
				</div>
			</div>
		);
	}

	const tabs: { id: SettingsTab; label: string }[] = [
		{ id: "users", label: "Users" },
		{ id: "roles", label: "Roles" },
		{ id: "audit", label: "Audit Log" },
		{ id: "tenant", label: "Tenant" },
		{ id: "github", label: "GitHub" },
		{ id: "oidc", label: "OIDC" },
	];

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-mist">Settings</h1>

			<div className="border-b border-slate-brand">
				<nav className="flex gap-1" aria-label="Settings tabs">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => selectTab(t.id)}
							className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
								tab === t.id
									? "border-lightning text-mist"
									: "border-transparent text-cloud hover:text-mist hover:border-cloud/30"
							}`}
						>
							{t.label}
						</button>
					))}
				</nav>
			</div>

			<div>
				{tab === "users" && (
					<UserManagement widgetId="user-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "roles" && (
					<RoleManagement widgetId="role-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "audit" && (
					<AuditManagement widgetId="audit-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "tenant" && (
					<TenantProfile widgetId="tenant-profile-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "github" && <GitHubSettingsTab />}
				{tab === "oidc" && <OidcSettingsTab />}
			</div>
		</div>
	);
}

/** The only authorization URL a GitHub outbound connect may hand the browser. */
const GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";

/** The only URL prefix a GitHub App installation link may hand the browser. */
const GITHUB_APP_INSTALL_URL_PREFIX = "https://github.com/apps/";

interface GitHubConnectTarget {
	accountLogin: string;
	accountType: "Organization" | "User";
	/** Installation of this App on the account, when GitHub reports one. */
	installationId: number | null;
	/** Already bound to the calling tenant. */
	connected: boolean;
	/** Installed and bound to a different tenant, so this tenant cannot claim it. */
	claimedByOtherTenant: boolean;
}

function GitHubSettingsTab() {
	const { data: status, isLoading, error: queryError, refetch } = trpc.github.status.useQuery();
	const startConnectMutation = trpc.github.startConnect.useMutation();
	const removeMutation = trpc.github.removeInstallation.useMutation();
	const connectInstallationMutation = trpc.github.connectInstallation.useMutation();
	const createInstallationUrlMutation = trpc.github.createInstallationUrl.useMutation();
	const sdk = useDescope();
	const [disconnectId, setDisconnectId] = useState<number | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const connectInFlight = useRef(false);
	const [connectPending, setConnectPending] = useState(false);
	const callback = new URLSearchParams(window.location.search).get("github");
	const callbackReason = new URLSearchParams(window.location.search).get("reason");

	const targetsEnabled = Boolean(
		status?.configured && status.connectAvailable && status.connectedLogin,
	);
	const {
		data: targetsData,
		error: targetsError,
		refetch: refetchTargets,
	} = trpc.github.connectTargets.useQuery(undefined, { enabled: targetsEnabled });

	useEffect(() => {
		const resetAfterHistoryRestore = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			connectInFlight.current = false;
			setConnectPending(false);
		};
		window.addEventListener("pageshow", resetAfterHistoryRestore);
		return () => window.removeEventListener("pageshow", resetAfterHistoryRestore);
	}, []);

	// The server mints a one-time transaction bound to this browser and cookie,
	// and returns only the outbound app id, tenant, and a server-built redirect
	// URL — never a token. The browser's own cookie-authenticated Descope SDK
	// performs the outbound connect call, so no session or refresh token is
	// ever read or handed to the caller, and the returned provider URL is
	// allowlisted to GitHub's authorization endpoint before navigation. No
	// account is chosen yet: this step only confirms who the caller is on
	// GitHub, before the accounts they administer are listed below.
	const handleContinueWithGitHub = async () => {
		if (connectInFlight.current) return;
		connectInFlight.current = true;
		setConnectPending(true);
		setActionError(null);
		try {
			const { appId, tenantId, redirectUrl } = await startConnectMutation.mutateAsync({});
			const response = await sdk.outbound.connect(appId, { redirectUrl, tenantId });
			const url = response.ok ? response.data?.url : undefined;
			if (typeof url !== "string" || url.length === 0) {
				throw new Error("Unable to start GitHub setup");
			}
			const parsed = new URL(url, GITHUB_AUTHORIZATION_URL);
			if (`${parsed.origin}${parsed.pathname}` !== GITHUB_AUTHORIZATION_URL) {
				throw new Error("Unable to start GitHub setup");
			}
			window.location.assign(parsed.toString());
		} catch (error) {
			connectInFlight.current = false;
			setConnectPending(false);
			setActionError(error instanceof Error ? error.message : "Unable to start GitHub setup");
		}
	};

	const handleConnectInstallation = async (installationId: number) => {
		setActionError(null);
		try {
			await connectInstallationMutation.mutateAsync({ installationId });
			await Promise.all([refetch(), refetchTargets()]);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Unable to connect the GitHub installation",
			);
		}
	};

	const handleInstall = async (accountLogin?: string) => {
		setActionError(null);
		try {
			const { url } = await createInstallationUrlMutation.mutateAsync({ accountLogin });
			if (!url.startsWith(GITHUB_APP_INSTALL_URL_PREFIX)) {
				throw new Error("Unable to start GitHub App installation");
			}
			window.location.assign(url);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Unable to start GitHub App installation",
			);
		}
	};

	const handleDisconnect = async () => {
		if (disconnectId === null) return;
		setActionError(null);
		try {
			await removeMutation.mutateAsync({ installationId: disconnectId });
			setDisconnectId(null);
			await Promise.all([refetch(), refetchTargets()]);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "Unable to disconnect GitHub");
		}
	};

	if (isLoading) {
		return (
			<div className="animate-pulse space-y-3">
				<div className="h-32 bg-slate-brand/30 rounded-xl border border-slate-brand/60" />
			</div>
		);
	}

	if (queryError) {
		return (
			<div className="bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
				Unable to load GitHub App status: {queryError.message}
			</div>
		);
	}

	if (!status?.configured) return <GitHubNotConfigured />;

	return (
		<div className="space-y-4">
			{callback === "connected" && (
				<div className="bg-success/10 border border-success/30 text-success p-4 rounded-xl text-sm">
					GitHub connected successfully.
				</div>
			)}
			{callback === "error" && (
				<div className="bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
					{githubCallbackError(callbackReason)}
				</div>
			)}
			{(actionError || targetsError) && (
				<div className="bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
					{actionError ?? targetsError?.message}
				</div>
			)}

			{!status.connectAvailable && (
				<div className="bg-lightning/10 border border-lightning/30 text-cloud p-4 rounded-xl text-sm">
					GitHub user verification is unavailable: this server has no Descope Outbound App
					connection. Installations cannot be connected until an administrator configures it.
				</div>
			)}

			{status.connectAvailable && !status.connectedLogin && (
				<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
					<h3 className="text-sm font-semibold text-mist mb-1.5">Connect a GitHub account</h3>
					<p className="text-sm text-cloud leading-relaxed mb-5">
						Authorize with GitHub first. Procella asks Descope to confirm your GitHub identity, then
						lists the accounts you administer so you can connect an existing installation or install
						the App fresh.
					</p>
					<button
						type="button"
						onClick={handleContinueWithGitHub}
						disabled={connectPending}
						className="btn-primary"
					>
						{connectPending ? "Opening GitHub…" : "Continue with GitHub"}
					</button>
				</div>
			)}

			{status.connectAvailable && status.connectedLogin && (
				<>
					<div className="flex items-center justify-between gap-4">
						<p className="text-sm text-cloud">
							Connected as GitHub user <strong>{status.connectedLogin}</strong>.
						</p>
						{/* Authorizing the wrong GitHub login would otherwise be a dead
						    end: the list below only ever shows what THIS identity
						    administers, and Disconnect exists per installation. */}
						<button
							type="button"
							onClick={handleContinueWithGitHub}
							disabled={connectPending}
							className="btn-secondary shrink-0"
						>
							{connectPending ? "Opening GitHub…" : "Change GitHub account"}
						</button>
					</div>
					{targetsData && targetsData.targets.length === 0 && (
						<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
							<h3 className="text-sm font-semibold text-mist mb-1.5">
								No GitHub accounts to connect
							</h3>
							<p className="text-sm text-cloud leading-relaxed">
								This GitHub user owns no account and administers no organization that Procella can
								list. Organizations without the App installed are invisible to it, so install on one
								through GitHub instead.
							</p>
						</div>
					)}
					{targetsData && targetsData.targets.length > 0 && (
						<div className="space-y-3">
							<h2 className="text-base font-semibold text-mist">Connect a GitHub account</h2>
							{targetsData.targets.map((target) => (
								<GitHubConnectTargetRow
									key={`${target.accountType}:${target.accountLogin}`}
									target={target}
									onConnect={handleConnectInstallation}
									onInstall={handleInstall}
									connectPending={connectInstallationMutation.isPending}
									installPending={createInstallationUrlMutation.isPending}
								/>
							))}
						</div>
					)}
					<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
						<h3 className="text-sm font-semibold text-mist mb-1.5">Install on another account</h3>
						<p className="text-sm text-cloud leading-relaxed mb-5">
							Organizations without the App installed cannot be listed above: GitHub limits this
							authorization to accounts the App can already reach. Pick the account on GitHub
							instead, and Procella verifies you administer whatever it installs on before binding
							it.
						</p>
						<button
							type="button"
							onClick={() => handleInstall()}
							disabled={createInstallationUrlMutation.isPending}
							className="btn-secondary"
						>
							{createInstallationUrlMutation.isPending
								? "Opening GitHub…"
								: "Choose an account on GitHub"}
						</button>
					</div>
				</>
			)}

			{status.installations.length > 0 && (
				<>
					<div className="flex items-center justify-between gap-4">
						<div>
							<h2 className="text-base font-semibold text-mist">GitHub App installations</h2>
							<p className="text-sm text-cloud mt-0.5">
								Procella verifies repository access before publishing each notification.
							</p>
						</div>
					</div>

					{status.installations.map((installation) => (
						<div
							key={installation.installationId}
							className="bg-slate-brand/50 border border-cloud/15 rounded-xl p-6"
						>
							<div className="flex items-start justify-between gap-4">
								<div>
									<h3 className="text-sm font-semibold text-mist mb-2">
										{installation.accountLogin}
									</h3>
									<div className="space-y-1 text-sm text-cloud">
										<p>
											<span className="text-cloud/60">Account type:</span>{" "}
											{installation.accountType}
										</p>
										<p>
											<span className="text-cloud/60">Installation ID:</span>{" "}
											<span className="tabular-nums">{installation.installationId}</span>
										</p>
										<p>
											<span className="text-cloud/60">Repository access:</span>{" "}
											{installation.repositorySelection === "all"
												? "All repositories"
												: "Selected repositories"}
										</p>
									</div>
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() => setDisconnectId(installation.installationId)}
										className="btn-danger"
									>
										Disconnect
									</button>
								</div>
							</div>
						</div>
					))}
				</>
			)}

			{disconnectId !== null && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
					<div className="bg-surface-popup border border-cloud/20 rounded-xl p-6 w-full max-w-sm mx-4">
						<h3 className="text-lg font-semibold text-mist mb-2">Disconnect GitHub App</h3>
						<p className="text-sm text-cloud mb-4">
							This removes the tenant binding from Procella and deletes your vaulted GitHub
							authorization. It does not uninstall the app on GitHub.
						</p>
						<div className="flex justify-end gap-3">
							<button type="button" onClick={() => setDisconnectId(null)} className="btn-ghost">
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDisconnect}
								disabled={removeMutation.isPending}
								className="btn-danger"
							>
								{removeMutation.isPending ? "Disconnecting…" : "Disconnect"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function githubCallbackError(reason: string | null): string {
	switch (reason) {
		case "expired_state":
			return "The GitHub setup link expired. Start the connection again.";
		case "replayed_state":
			return "This GitHub setup link was already used. Start the connection again.";
		case "installation_conflict":
			return "This GitHub installation is already connected to another tenant.";
		case "invalid_installation":
			return "GitHub did not return a valid installation for this app.";
		case "authorization_failed":
			return "GitHub user authorization failed. Start the connection again.";
		case "authorization_required":
			return "Your GitHub user must own the account or be an active organization administrator.";
		case "authorization_unavailable":
			return "GitHub user verification is not configured on this server.";
		case "unauthorized_account":
			return "GitHub returned an installation for a different account. Start the connection again.";
		case "unsupported_setup_action":
			return "GitHub returned an unsupported setup callback. Start the connection again.";
		case "invalid_state":
			return "This GitHub connection could not be verified. Start the connection again.";
		case "not_configured":
			return "The GitHub App is not configured on this server.";
		default:
			return "GitHub setup could not be completed. Start the connection again.";
	}
}

function GitHubNotConfigured() {
	return (
		<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
			<h3 className="text-sm font-semibold text-cloud mb-1.5">GitHub App is not configured</h3>
			<p className="text-sm text-cloud/60 leading-relaxed mb-4">
				A server administrator must configure the GitHub App before tenants can connect it. GitHub
				user authorization runs through a Descope Outbound App, so no OAuth client secret is needed
				here.
			</p>
			<div className="bg-deep-sky border border-cloud/15 rounded-lg px-3 py-2.5 font-mono text-xs text-cloud overflow-x-auto whitespace-pre leading-relaxed">
				{`PROCELLA_GITHUB_APP_ID=<your-app-id>
PROCELLA_GITHUB_APP_PRIVATE_KEY=<your-private-key>
PROCELLA_GITHUB_APP_WEBHOOK_SECRET=<your-webhook-secret>
PROCELLA_APP_ORIGIN=https://app.example.com`}
			</div>
		</div>
	);
}

function GitHubConnectTargetRow({
	target,
	onConnect,
	onInstall,
	connectPending,
	installPending,
}: {
	target: GitHubConnectTarget;
	onConnect: (installationId: number) => void;
	onInstall: (accountLogin: string) => void;
	connectPending: boolean;
	installPending: boolean;
}) {
	const { accountLogin, accountType, installationId, connected, claimedByOtherTenant } = target;
	return (
		<div className="bg-slate-brand/50 border border-cloud/15 rounded-xl p-6 flex items-center justify-between gap-4">
			<div>
				<h3 className="text-sm font-semibold text-mist">{accountLogin}</h3>
				<p className="text-sm text-cloud/60">{accountType}</p>
			</div>
			{claimedByOtherTenant ? (
				<div className="text-right max-w-xs">
					<button type="button" disabled className="btn-primary opacity-50 cursor-not-allowed">
						Connect
					</button>
					<p className="text-xs text-cloud/60 mt-1">Already connected to a different tenant.</p>
				</div>
			) : connected ? (
				<span className="text-sm text-success">Connected</span>
			) : installationId !== null ? (
				<button
					type="button"
					onClick={() => onConnect(installationId)}
					disabled={connectPending}
					className="btn-primary"
				>
					{connectPending ? "Connecting…" : "Connect"}
				</button>
			) : (
				<button
					type="button"
					onClick={() => onInstall(accountLogin)}
					disabled={installPending}
					className="btn-primary"
				>
					{installPending ? "Opening GitHub…" : "Install"}
				</button>
			)}
		</div>
	);
}

// ============================================================================
// OIDC Settings Tab
// ============================================================================

function OidcSettingsTab() {
	const [showCreate, setShowCreate] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [issuer, setIssuer] = useState("https://token.actions.githubusercontent.com");
	const [maxExpiration, setMaxExpiration] = useState("7200");
	const [grantedRole, setGrantedRole] = useState<"viewer" | "member" | "admin">("member");
	const [conditionKey, setConditionKey] = useState("");
	const [conditionValue, setConditionValue] = useState("");
	const [conditions, setConditions] = useState<Record<string, string>>({});

	const {
		data: policies,
		isLoading,
		error: queryError,
		refetch,
	} = trpc.oidc.listPolicies.useQuery();

	const createMutation = trpc.oidc.createPolicy.useMutation();
	const deleteMutation = trpc.oidc.deletePolicy.useMutation();
	const toggleMutation = trpc.oidc.updatePolicy.useMutation();

	const resetForm = () => {
		setDisplayName("");
		setIssuer("https://token.actions.githubusercontent.com");
		setMaxExpiration("7200");
		setGrantedRole("member");
		setConditions({});
		setConditionKey("");
		setConditionValue("");
		setFormError(null);
	};

	const handleCreate = async () => {
		if (!displayName.trim()) {
			setFormError("Display name is required");
			return;
		}
		if (!issuer.trim()) {
			setFormError("Issuer URL is required");
			return;
		}
		const exp = Number(maxExpiration);
		if (!Number.isInteger(exp) || exp < 60 || exp > 86400) {
			setFormError("Expiration must be between 60 and 86400 seconds");
			return;
		}
		if (Object.keys(conditions).length < 2) {
			setFormError("At least two claim conditions are required");
			return;
		}
		try {
			await createMutation.mutateAsync({
				provider: "github-actions",
				displayName: displayName.trim(),
				issuer: issuer.trim(),
				maxExpiration: exp,
				claimConditions: conditions,
				grantedRole,
			});
			resetForm();
			setShowCreate(false);
			refetch();
		} catch (err: unknown) {
			setFormError(err instanceof Error ? err.message : "Failed to create policy");
		}
	};

	const addCondition = () => {
		if (!conditionKey.trim() || !conditionValue.trim()) return;
		setConditions((prev) => ({ ...prev, [conditionKey.trim()]: conditionValue.trim() }));
		setConditionKey("");
		setConditionValue("");
	};

	const removeCondition = (key: string) => {
		setConditions((prev) => {
			const n = { ...prev };
			delete n[key];
			return n;
		});
	};

	if (isLoading) {
		return (
			<div className="animate-pulse h-32 bg-slate-brand/30 rounded-xl border border-slate-brand/60 mt-4" />
		);
	}

	if (queryError) {
		if (queryError.message.includes("OIDC is not enabled")) {
			return (
				<div className="mt-6 bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-mist font-medium">OIDC CI Authentication</p>
					<p className="text-cloud text-sm mt-2">
						Set <code className="font-mono text-lightning">PROCELLA_OIDC_ENABLED=true</code> to
						enable OIDC trust policy management.
					</p>
				</div>
			);
		}
		return (
			<div className="mt-4 bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
				{queryError.message}
			</div>
		);
	}

	return (
		<div className="mt-6 space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-base font-semibold text-mist">OIDC Trust Policies</h2>
					<p className="text-sm text-cloud mt-0.5">
						Allow CI pipelines to authenticate using OpenID Connect tokens.
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						resetForm();
						setShowCreate(true);
					}}
					className="btn-primary"
				>
					Add Policy
				</button>
			</div>

			{showCreate && (
				<div className="bg-surface-popup border border-cloud/15 rounded-xl p-5 space-y-4">
					<h3 className="text-sm font-semibold text-mist">New Trust Policy</h3>
					{formError && (
						<div className="bg-danger/10 border border-danger/30 text-danger/80 p-3 rounded-lg text-sm">
							{formError}
						</div>
					)}
					<div className="grid grid-cols-2 gap-4">
						<div>
							<label htmlFor="oidc-display-name" className="block text-xs text-cloud mb-1">
								Display Name
							</label>
							<input
								id="oidc-display-name"
								type="text"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="CI Deploy Policy"
								className="w-full input-field"
							/>
						</div>
						<div>
							<label htmlFor="oidc-role" className="block text-xs text-cloud mb-1">
								Granted Role
							</label>
							<select
								id="oidc-role"
								value={grantedRole}
								onChange={(e) => setGrantedRole(e.target.value as "viewer" | "member" | "admin")}
								className="w-full input-field"
							>
								<option value="viewer">viewer</option>
								<option value="member">member</option>
								<option value="admin">admin</option>
							</select>
						</div>
					</div>
					<div>
						<label htmlFor="oidc-issuer" className="block text-xs text-cloud mb-1">
							OIDC Issuer URL
						</label>
						<input
							id="oidc-issuer"
							type="url"
							value={issuer}
							onChange={(e) => setIssuer(e.target.value)}
							className="w-full input-field"
						/>
					</div>
					<div>
						<label htmlFor="oidc-expiry" className="block text-xs text-cloud mb-1">
							Max Token Expiration (seconds)
						</label>
						<input
							id="oidc-expiry"
							type="number"
							value={maxExpiration}
							onChange={(e) => setMaxExpiration(e.target.value)}
							min={60}
							max={86400}
							className="w-full input-field"
						/>
					</div>
					<div>
						<p className="block text-xs text-cloud mb-1">
							Claim Conditions (AND semantics, exact match)
						</p>
						<div className="flex gap-2 mb-2">
							<input
								type="text"
								value={conditionKey}
								onChange={(e) => setConditionKey(e.target.value)}
								placeholder="repository_owner_id"
								onKeyDown={(e) => e.key === "Enter" && addCondition()}
								className="flex-1 input-field"
							/>
							<input
								type="text"
								value={conditionValue}
								onChange={(e) => setConditionValue(e.target.value)}
								placeholder="12345"
								onKeyDown={(e) => e.key === "Enter" && addCondition()}
								className="flex-1 input-field"
							/>
							<button type="button" onClick={addCondition} className="btn-secondary">
								Add
							</button>
						</div>
						<p className="text-xs text-cloud/70 mb-2">
							Recommended: add <code>repository_owner_id</code> and <code>repository_id</code>
							using stable numeric GitHub IDs. <code>ref</code> and <code>environment</code> only
							add restrictions; they do not authorize a repository by themselves.
						</p>
						{Object.entries(conditions).map(([k, v]) => (
							<div
								key={k}
								className="flex items-center gap-2 text-xs font-mono text-mist/80 bg-slate-brand/50 rounded px-2 py-1 mb-1"
							>
								<span className="flex-1">
									{k} = {v}
								</span>
								<button
									type="button"
									onClick={() => removeCondition(k)}
									className="text-cloud/60 hover:text-danger/80 transition-colors"
								>
									×
								</button>
							</div>
						))}
					</div>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => {
								resetForm();
								setShowCreate(false);
							}}
							className="btn-ghost"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleCreate}
							disabled={createMutation.isPending}
							className="btn-primary"
						>
							{createMutation.isPending ? "Creating…" : "Create Policy"}
						</button>
					</div>
				</div>
			)}

			{policies && policies.length === 0 && !showCreate && (
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-cloud text-sm">
						No trust policies configured. Add one to enable OIDC CI authentication.
					</p>
				</div>
			)}

			{policies && policies.length > 0 && (
				<div className="space-y-2">
					{policies.map((policy) => (
						<div key={policy.id} className="bg-surface-popup border border-cloud/15 rounded-xl p-4">
							<div className="flex items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-mist">{policy.displayName}</span>
										<span
											className={`text-xs px-1.5 py-0.5 rounded font-mono ${policy.active ? "bg-success/10 text-success/80" : "bg-slate-brand text-cloud/60"}`}
										>
											{policy.active ? "active" : "inactive"}
										</span>
										<span className="text-xs px-1.5 py-0.5 rounded bg-slate-brand text-cloud font-mono">
											{policy.grantedRole}
										</span>
									</div>
									<p className="text-xs text-cloud font-mono mt-1 truncate">{policy.issuer}</p>
									{Object.keys(policy.claimConditions).length > 0 && (
										<div className="flex flex-wrap gap-1 mt-2">
											{Object.entries(policy.claimConditions).map(([k, v]) => (
												<span
													key={k}
													className="text-xs font-mono bg-slate-brand/70 text-cloud px-2 py-0.5 rounded"
												>
													{k}={v}
												</span>
											))}
										</div>
									)}
								</div>
								<div className="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onClick={() => {
											toggleMutation
												.mutateAsync({ id: policy.id, active: !policy.active })
												.then(() => refetch())
												.catch((e: unknown) =>
													setFormError(e instanceof Error ? e.message : "Update failed"),
												);
										}}
										className="text-xs text-cloud hover:text-mist px-2 py-1 rounded border border-cloud/20 hover:border-cloud/40 transition-colors"
									>
										{policy.active ? "Disable" : "Enable"}
									</button>
									<button
										type="button"
										onClick={() => {
											deleteMutation
												.mutateAsync({ id: policy.id })
												.then(() => refetch())
												.catch((e: unknown) =>
													setFormError(e instanceof Error ? e.message : "Delete failed"),
												);
										}}
										className="text-xs text-danger/70 hover:text-danger px-2 py-1 rounded border border-danger/20 hover:border-danger/40 transition-colors"
									>
										Delete
									</button>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
