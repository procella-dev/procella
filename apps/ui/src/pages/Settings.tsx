import {
	AuditManagement,
	getCurrentTenant,
	getJwtRoles,
	RoleManagement,
	TenantProfile,
	UserManagement,
	useSession,
} from "@descope/react-sdk";
import { useEffect, useState } from "react";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { trpc } from "../trpc";

type SettingsTab = "users" | "roles" | "audit" | "tenant" | "github";

function getTab(): SettingsTab {
	const hash = window.location.hash.slice(1);
	if (hash === "roles" || hash === "audit" || hash === "tenant" || hash === "github") return hash;
	return "users";
}

export function Settings() {
	const { config } = useAuthConfig();
	const { sessionToken } = useSession();
	const [tab, setTab] = useState<SettingsTab>(getTab);

	useEffect(() => {
		const onHashChange = () => setTab(getTab());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	if (config?.mode !== "descope") return null;

	const tenantId = sessionToken ? getCurrentTenant(sessionToken) : "";
	const roles = sessionToken ? getJwtRoles(sessionToken, tenantId) : [];
	const isAdmin = roles.includes("admin");

	const selectTab = (t: SettingsTab) => {
		window.location.hash = t;
		setTab(t);
	};

	if (!tenantId) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-cloud">Loading session…</p>
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
			</div>
		</div>
	);
}

function GitHubSettingsTab() {
	const {
		data: installation,
		isLoading,
		error: queryError,
		refetch,
	} = trpc.github.installation.useQuery();
	const error = queryError?.message ?? null;

	const removeMutation = trpc.github.removeInstallation.useMutation();
	const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

	if (isLoading) {
		return (
			<div className="animate-pulse space-y-3">
				<div className="h-32 bg-zinc-900 rounded-xl border border-zinc-800" />
			</div>
		);
	}

	if (!error && installation === null) {
		return <GitHubNotConfigured onCheckConnection={refetch} />;
	}

	if (error) {
		// If the error indicates GitHub is not configured on the server
		return <GitHubNotConfigured onCheckConnection={refetch} />;
	}

	if (!installation) {
		return <GitHubNotConnected onCheckConnection={refetch} />;
	}

	const handleDisconnect = async () => {
		try {
			await removeMutation.mutateAsync();
			setShowDisconnectConfirm(false);
			refetch();
		} catch {
			// Error handled by tRPC
		}
	};

	return (
		<>
			<div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
				<div className="flex items-start justify-between">
					<div className="flex items-start gap-4">
						<div className="w-10 h-10 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0">
							<svg
								viewBox="0 0 24 24"
								fill="currentColor"
								className="w-6 h-6 text-zinc-300"
								aria-hidden="true"
							>
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-zinc-100 mb-1">GitHub App Connected</h3>
							<div className="space-y-1">
								<p className="text-sm text-zinc-400">
									<span className="text-zinc-500">Account:</span>{" "}
									<span className="text-zinc-200 font-medium">{installation.accountLogin}</span>
								</p>
								<p className="text-sm text-zinc-400">
									<span className="text-zinc-500">Type:</span> {installation.accountType}
								</p>
								<p className="text-sm text-zinc-400">
									<span className="text-zinc-500">Installation ID:</span>{" "}
									<span className="tabular-nums">{installation.installationId}</span>
								</p>
								<p className="text-sm text-zinc-400">
									<span className="text-zinc-500">Repositories:</span>{" "}
									{installation.repositorySelection === "all"
										? "All repositories"
										: "Selected repositories"}
								</p>
								<p className="text-sm text-zinc-400">
									<span className="text-zinc-500">Connected:</span>{" "}
									{new Date(installation.createdAt).toLocaleDateString()}
								</p>
							</div>
						</div>
					</div>
					<button
						type="button"
						onClick={() => setShowDisconnectConfirm(true)}
						className="bg-red-950/40 hover:bg-red-950/60 text-red-400 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border border-red-900/40"
					>
						Disconnect
					</button>
				</div>
			</div>

			{showDisconnectConfirm && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
					<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm mx-4">
						<h3 className="text-lg font-semibold text-zinc-100 mb-2">Disconnect GitHub App</h3>
						<p className="text-sm text-zinc-400 mb-4">
							Are you sure you want to disconnect the GitHub App? PR comments and commit statuses
							will stop working.
						</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowDisconnectConfirm(false)}
								className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDisconnect}
								disabled={removeMutation.isPending}
								className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
							>
								{removeMutation.isPending ? "Disconnecting..." : "Disconnect"}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function GitHubNotConfigured({ onCheckConnection }: { onCheckConnection: () => void }) {
	return (
		<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8">
			<div className="flex items-start gap-4">
				<div className="w-10 h-10 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0 opacity-50">
					<svg
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-6 h-6 text-zinc-500"
						aria-hidden="true"
					>
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
				</div>
				<div>
					<h3 className="text-sm font-semibold text-zinc-400 mb-1.5">
						GitHub App Not Configured or Not Installed
					</h3>
					<p className="text-sm text-zinc-500 leading-relaxed mb-4">
						Procella cannot yet distinguish between missing server configuration and a missing
						organization installation. Verify environment variables and app installation:
					</p>
					<div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 font-mono text-xs text-zinc-400 overflow-x-auto whitespace-pre leading-relaxed mb-4">
						{`PROCELLA_GITHUB_APP_ID=<your-app-id>
PROCELLA_GITHUB_APP_PRIVATE_KEY=<your-private-key>
PROCELLA_GITHUB_APP_WEBHOOK_SECRET=<your-webhook-secret>`}
					</div>
					<button
						type="button"
						onClick={onCheckConnection}
						className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
					>
						Check Connection
					</button>
				</div>
			</div>
		</div>
	);
}

function GitHubNotConnected({ onCheckConnection }: { onCheckConnection: () => void }) {
	return (
		<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8">
			<div className="flex items-start gap-4">
				<div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
					<svg
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-6 h-6 text-blue-400"
						aria-hidden="true"
					>
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
				</div>
				<div>
					<h3 className="text-sm font-semibold text-zinc-100 mb-1.5">Connect GitHub App</h3>
					<p className="text-sm text-zinc-400 leading-relaxed mb-5">
						Connect a GitHub App to enable PR comments and commit status checks for Pulumi previews.
					</p>

					<div className="space-y-3 mb-5">
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-semibold text-zinc-400 shrink-0 mt-0.5">
								1
							</span>
							<div>
								<p className="text-xs text-zinc-500 mb-0.5">Create a GitHub App</p>
								<a
									href="https://github.com/settings/apps/new"
									target="_blank"
									rel="noopener noreferrer"
									className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
								>
									GitHub Settings → Developer settings → GitHub Apps →
								</a>
							</div>
						</div>
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-semibold text-zinc-400 shrink-0 mt-0.5">
								2
							</span>
							<p className="text-xs text-zinc-500">
								Set PROCELLA_GITHUB_APP_ID, PROCELLA_GITHUB_APP_PRIVATE_KEY, and
								PROCELLA_GITHUB_APP_WEBHOOK_SECRET environment variables
							</p>
						</div>
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-semibold text-zinc-400 shrink-0 mt-0.5">
								3
							</span>
							<p className="text-xs text-zinc-500">Install the GitHub App on your organization</p>
						</div>
					</div>

					<button
						type="button"
						onClick={onCheckConnection}
						className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
					>
						Check Connection
					</button>
				</div>
			</div>
		</div>
	);
}
