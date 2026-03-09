import { AccessKeyManagement, getCurrentTenant, UserProfile, useSession } from "@descope/react-sdk";
import { useState } from "react";

type TokensTab = "profile" | "tokens";

export function Tokens() {
	const { sessionToken } = useSession();
	const tenantId = sessionToken ? getCurrentTenant(sessionToken) : "";
	const [tab, setTab] = useState<TokensTab>("tokens");

	if (!tenantId) {
		return (
			<div className="space-y-4">
				<h1 className="text-2xl font-bold text-zinc-100">API Tokens</h1>
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-12 text-center">
					<p className="text-zinc-500">Loading session…</p>
				</div>
			</div>
		);
	}

	const tabs: { id: TokensTab; label: string }[] = [
		{ id: "tokens", label: "API Tokens" },
		{ id: "profile", label: "Profile" },
	];

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-zinc-100">API Tokens</h1>

			<div className="border-b border-zinc-800">
				<nav className="flex gap-1" aria-label="Tokens tabs">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setTab(t.id)}
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
				{tab === "tokens" && (
					<AccessKeyManagement
						widgetId="user-access-key-management-widget"
						tenant={tenantId}
						theme="dark"
					/>
				)}
				{tab === "profile" && <UserProfile widgetId="user-profile-widget" theme="dark" />}
			</div>
		</div>
	);
}
