import { Descope } from "@descope/react-sdk";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { FullPageSpinner } from "../components/FullPageSpinner";
import { ProcellaLogo } from "../components/ProcellaLogo";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function Login() {
	const { config, isLoading } = useAuthConfig();
	const location = useLocation();
	const returnTo = (location.state as { returnTo?: string })?.returnTo ?? "/";

	if (isLoading || !config) {
		return <FullPageSpinner />;
	}

	if (config.mode === "descope") {
		return <DescopeLogin returnTo={returnTo} />;
	}

	return <DevLogin returnTo={returnTo} />;
}

function DescopeLogin({ returnTo }: { returnTo: string }) {
	const navigate = useNavigate();

	return (
		<div className="min-h-screen bg-deep-sky flex flex-col items-center justify-center px-4">
			<ProcellaLogo linkTo="/" className="mb-3" />
			<p className="text-sm text-cloud mb-8">Sign in to your Pulumi backend</p>
			<div
				className="w-full max-w-md"
				style={
					{
						fontFamily: "var(--font-sans)",
						"--descope-font-family": "var(--font-sans)",
						"--descope-background-color": "transparent",
					} as React.CSSProperties
				}
			>
				<Descope
					flowId="sign-up-or-in"
					theme="dark"
					onSuccess={() => navigate(returnTo, { replace: true })}
					onError={() => {}}
				/>
			</div>
		</div>
	);
}

function DevLogin({ returnTo }: { returnTo: string }) {
	const navigate = useNavigate();
	const [token, setToken] = useState("");

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!token.trim()) return;
		localStorage.setItem("procella-token", token.trim());
		navigate(returnTo, { replace: true });
	};

	return (
		<div className="min-h-screen bg-deep-sky flex flex-col items-center justify-center px-4">
			<ProcellaLogo linkTo="/" className="mb-3" />
			<p className="text-sm text-cloud mb-8">Enter your API token to continue</p>
			<form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
				<input
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="API token"
					className="w-full bg-slate-brand border border-cloud/30 rounded-lg px-4 py-3 text-sm text-mist placeholder-cloud focus:outline-none focus:ring-2 focus:ring-lightning focus:border-transparent transition-all"
				/>
				<button
					type="submit"
					disabled={!token.trim()}
					className="w-full bg-lightning hover:bg-lightning/80 disabled:bg-slate-brand disabled:text-cloud text-deep-sky font-medium py-3 px-4 rounded-lg transition-colors"
				>
					Connect
				</button>
			</form>
			<div className="mt-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-brand/50 border border-cloud/20">
				<span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
				<span className="text-xs text-cloud">Dev mode</span>
			</div>
		</div>
	);
}
