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

type SettingsTab = "users" | "roles" | "audit" | "tenant";

function getTab(): SettingsTab {
	const hash = window.location.hash.slice(1);
	if (hash === "roles" || hash === "audit" || hash === "tenant") return hash;
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
				<h1 className="text-2xl font-bold text-zinc-100">Settings</h1>
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-12 text-center">
					<p className="text-zinc-500">Loading session…</p>
				</div>
			</div>
		);
	}

	if (!isAdmin) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-zinc-100">Settings</h1>
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-12 text-center">
					<p className="text-zinc-300 font-medium">Admin access required</p>
					<p className="text-zinc-500 text-sm mt-1">
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
	];

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-zinc-100">Settings</h1>

			<div className="border-b border-zinc-800">
				<nav className="flex gap-1" aria-label="Settings tabs">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => selectTab(t.id)}
							className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
								tab === t.id
									? "border-blue-500 text-zinc-100"
									: "border-transparent text-zinc-400 hover:text-zinc-100 hover:border-zinc-600"
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
			</div>
		</div>
	);
}
