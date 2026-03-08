import { useDescope, useUser } from "@descope/react-sdk";
import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";

export function Layout() {
	const { config } = useAuthConfig();

	return (
		<div className="min-h-screen flex flex-col">
			<header className="bg-zinc-950 border-b border-zinc-800 sticky top-0 z-10">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
					<div className="flex items-center gap-4">
						<Link
							to="/"
							className="text-xl font-bold tracking-tight text-zinc-100 hover:text-white transition-colors"
						>
							Strata
						</Link>
						<span className="px-2 py-1 rounded-md bg-zinc-800 text-xs font-medium text-zinc-400 border border-zinc-700">
							Pulumi Backend
						</span>
					</div>
					{config?.mode === "descope" ? <DescopeUserMenu /> : <DevTokenInput />}
				</div>
			</header>
			<main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<Outlet />
			</main>
		</div>
	);
}

function DescopeUserMenu() {
	const { user } = useUser();
	const { logout } = useDescope();
	const navigate = useNavigate();

	const displayName = user?.name || user?.email || "User";

	const handleLogout = () => {
		logout();
		navigate("/login", { replace: true });
	};

	return (
		<div className="flex items-center gap-3">
			<span className="text-sm text-zinc-300">{displayName}</span>
			<button
				type="button"
				onClick={handleLogout}
				className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
			>
				Sign out
			</button>
		</div>
	);
}

function DevTokenInput() {
	const [token, setToken] = useState("");

	useEffect(() => {
		const savedToken = localStorage.getItem("strata-token");
		if (savedToken) {
			setToken(savedToken);
		}
	}, []);

	const handleTokenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newToken = e.target.value;
		setToken(newToken);
		localStorage.setItem("strata-token", newToken);
	};

	return (
		<div className="flex items-center gap-3">
			<label htmlFor="token" className="text-sm font-medium text-zinc-400">
				Token
			</label>
			<input
				id="token"
				type="password"
				value={token}
				onChange={handleTokenChange}
				placeholder="Enter API token..."
				className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-64 transition-all"
			/>
		</div>
	);
}
