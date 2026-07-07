import { AccessKeyManagement, UserProfile, useSession } from "@descope/react-sdk";
import { useState } from "react";
import { tenantFromClaims } from "../auth/claims";

type TokensTab = "profile" | "tokens";

export function Tokens() {
	const { claims } = useSession();
	const tenantId = tenantFromClaims(claims);
	const [tab, setTab] = useState<TokensTab>("tokens");

	if (!tenantId) {
		return (
			<div className="space-y-4">
				<h1 className="text-2xl font-bold text-mist">API Tokens</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-cloud">Loading session…</p>
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
			<h1 className="text-2xl font-bold text-mist">API Tokens</h1>

			<div className="border-b border-slate-brand">
				<nav className="flex gap-1" aria-label="Tokens tabs">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setTab(t.id)}
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
