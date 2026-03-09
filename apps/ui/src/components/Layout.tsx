import { getCurrentTenant, getJwtRoles, useDescope, useSession, useUser } from "@descope/react-sdk";
import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";

function useIsAdmin() {
	const { sessionToken } = useSession();
	if (!sessionToken) return false;
	const tenantId = getCurrentTenant(sessionToken);
	if (!tenantId) return false;
	return getJwtRoles(sessionToken, tenantId).includes("admin");
}

export function Layout() {
	const { config } = useAuthConfig();
	const isAdmin = useIsAdmin();

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
						{config?.mode === "descope" && (
							<Link
								to="/tokens"
								className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
							>
								Tokens
							</Link>
						)}
						{config?.mode === "descope" && isAdmin && (
							<Link
								to="/settings"
								className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
							>
								Settings
							</Link>
						)}
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
	const sdk = useDescope();
	const { user } = useUser();
	const { isAuthenticated } = useSession();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	if (!isAuthenticated || !user) return null;

	const initials =
		[user.givenName, user.familyName]
			.filter(Boolean)
			.map((n) => n?.[0])
			.join("")
			.toUpperCase() ||
		user.email?.[0]?.toUpperCase() ||
		"?";

	const displayName =
		[user.givenName, user.familyName].filter(Boolean).join(" ") || user.email || "User";

	async function handleLogout() {
		await sdk.logout();
		navigate("/login", { replace: true });
	}

	return (
		<div className="relative" ref={menuRef}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-zinc-950"
			>
				<span className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-semibold text-white select-none">
					{initials}
				</span>
			</button>

			{open && (
				<div className="absolute right-0 mt-2 w-56 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl py-1 z-50">
					<div className="px-4 py-3 border-b border-zinc-700">
						<p className="text-sm font-medium text-zinc-100 truncate">{displayName}</p>
						{user.email && <p className="text-xs text-zinc-400 truncate mt-0.5">{user.email}</p>}
					</div>
					<button
						type="button"
						onClick={handleLogout}
						className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
					>
						Sign out
					</button>
				</div>
			)}
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
