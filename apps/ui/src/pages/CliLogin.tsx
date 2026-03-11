import { Descope, useDescope, useSession, useUser } from "@descope/react-sdk";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { apiBase } from "../config";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function CliLogin() {
	const { config, isLoading } = useAuthConfig();
	const [searchParams] = useSearchParams();

	const cliPort = searchParams.get("cliSessionPort");
	const cliNonce = searchParams.get("cliSessionNonce");
	const cliDesc = searchParams.get("cliSessionDescription");

	if (isLoading || !config) {
		return <LoadingScreen />;
	}

	if (!cliPort || !cliNonce) {
		return (
			<Screen>
				<p className="text-red-400 text-sm">
					Invalid CLI login request: missing session parameters.
				</p>
			</Screen>
		);
	}

	if (config.mode === "descope") {
		return <DescopeCliLogin port={cliPort} nonce={cliNonce} description={cliDesc} />;
	}

	return <DevCliLogin port={cliPort} nonce={cliNonce} />;
}

function DescopeCliLogin({
	port,
	nonce,
	description,
}: {
	port: string;
	nonce: string;
	description: string | null;
}) {
	const { isAuthenticated } = useSession();
	const { user } = useUser();
	const sdk = useDescope();
	const [status, setStatus] = useState<"idle" | "creating" | "done" | "error">("idle");
	const [errorMsg, setErrorMsg] = useState("");
	const didCreate = useRef(false);

	const createToken = () => {
		if (didCreate.current) return;
		didCreate.current = true;
		setStatus("creating");

		const sessionToken = sdk.getSessionToken();
		fetch(`${apiBase}/api/auth/cli-token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${sessionToken}`,
			},
			body: JSON.stringify({
				name: description ? `procella-cli: ${description}` : undefined,
			}),
		})
			.then((r) => r.json() as Promise<{ token?: string; error?: string }>)
			.then((data) => {
				if (!data.token) throw new Error(data.error ?? "No token returned");
				setStatus("done");
				const url = `http://localhost:${port}/?accessToken=${encodeURIComponent(data.token)}&nonce=${encodeURIComponent(nonce)}`;
				window.location.href = url;
			})
			.catch((err: unknown) => {
				setErrorMsg(err instanceof Error ? err.message : "Unknown error");
				setStatus("error");
			});
	};

	if (!isAuthenticated) {
		return (
			<Screen>
				<div className="w-full max-w-md">
					{description && <p className="text-zinc-400 text-sm text-center mb-6">{description}</p>}
					<Descope flowId="sign-up-or-in" theme="dark" onSuccess={() => {}} onError={() => {}} />
				</div>
			</Screen>
		);
	}

	if (status === "creating" || status === "done") {
		return (
			<Screen>
				<div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-8 flex flex-col items-center gap-4">
					<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
					<p className="text-zinc-400 text-sm">Redirecting back to the CLI…</p>
				</div>
			</Screen>
		);
	}

	if (status === "error") {
		return (
			<Screen>
				<div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-8 space-y-3 text-center">
					<p className="text-red-400 text-sm">{errorMsg}</p>
					<p className="text-zinc-500 text-xs">
						Make sure <code className="text-zinc-300">PROCELLA_DESCOPE_MANAGEMENT_KEY</code> is set
						on the server.
					</p>
				</div>
			</Screen>
		);
	}

	const email =
		user?.email || [user?.givenName, user?.familyName].filter(Boolean).join(" ") || "your account";

	return (
		<Screen>
			<div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-8 space-y-6">
				<div className="text-center space-y-1">
					<p className="text-zinc-400 text-sm">Authorize Pulumi CLI</p>
					{description && <p className="text-zinc-500 text-xs">{description}</p>}
				</div>

				<div className="bg-zinc-800/60 border border-zinc-700/50 rounded-xl px-4 py-3 flex items-center gap-3">
					<div className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-semibold text-white shrink-0 select-none">
						{email[0].toUpperCase()}
					</div>
					<span className="text-sm text-zinc-200 truncate">{email}</span>
				</div>

				<div className="space-y-3">
					<button
						type="button"
						onClick={createToken}
						className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 px-4 rounded-xl transition-colors"
					>
						Continue
					</button>
					<button
						type="button"
						onClick={() => sdk.logout()}
						className="w-full text-zinc-400 hover:text-zinc-200 text-sm py-2 transition-colors"
					>
						Use a different account
					</button>
				</div>
			</div>
		</Screen>
	);
}

function DevCliLogin({ port, nonce }: { port: string; nonce: string }) {
	const [token, setToken] = useState("");
	const [submitted, setSubmitted] = useState(false);

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!token.trim() || submitted) return;
		setSubmitted(true);
		window.location.href = `http://localhost:${port}/?accessToken=${encodeURIComponent(token.trim())}&nonce=${encodeURIComponent(nonce)}`;
	};

	return (
		<Screen>
			<div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-8 space-y-4">
				<form onSubmit={handleSubmit} className="space-y-4">
					<input
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder="API token"
						className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
					/>
					<button
						type="submit"
						disabled={!token.trim() || submitted}
						className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium py-3 px-4 rounded-xl transition-colors"
					>
						Authorize
					</button>
				</form>
			</div>
		</Screen>
	);
}

function Screen({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center px-4">
			<div className="mb-8 text-center">
				<h1 className="text-3xl font-bold text-zinc-100">Procella</h1>
				<p className="mt-2 text-sm text-zinc-400">Sign in to your Pulumi backend</p>
			</div>
			{children}
		</div>
	);
}

function LoadingScreen() {
	return (
		<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
			<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
		</div>
	);
}
