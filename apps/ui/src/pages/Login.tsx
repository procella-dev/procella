import { Descope } from "@descope/react-sdk";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function Login() {
	const { config, isLoading } = useAuthConfig();
	const location = useLocation();
	const returnTo = (location.state as { returnTo?: string })?.returnTo ?? "/";

	if (isLoading || !config) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
			</div>
		);
	}

	if (config.mode === "descope") {
		return <DescopeLogin returnTo={returnTo} />;
	}

	return <DevLogin returnTo={returnTo} />;
}

function DescopeLogin({ returnTo }: { returnTo: string }) {
	const navigate = useNavigate();

	return (
		<div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center">
			<div className="mb-8 text-center">
				<h1 className="text-3xl font-bold text-zinc-100">Strata</h1>
				<p className="mt-2 text-sm text-zinc-400">Sign in to your Pulumi backend</p>
			</div>
			<div className="w-full max-w-md">
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
		localStorage.setItem("strata-token", token.trim());
		navigate(returnTo, { replace: true });
	};

	return (
		<div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center">
			<div className="mb-8 text-center">
				<h1 className="text-3xl font-bold text-zinc-100">Strata</h1>
				<p className="mt-2 text-sm text-zinc-400">Enter your API token to continue</p>
			</div>
			<form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
				<input
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="API token"
					className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
				/>
				<button
					type="submit"
					disabled={!token.trim()}
					className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium py-3 px-4 rounded-lg transition-colors"
				>
					Connect
				</button>
			</form>
			<p className="mt-6 text-xs text-zinc-600">Dev mode</p>
		</div>
	);
}
