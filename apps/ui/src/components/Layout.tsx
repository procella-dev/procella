import { getCurrentTenant, getJwtRoles, useDescope, useSession, useUser } from "@descope/react-sdk";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { CommandBar, openCommandBar } from "./CommandBar";
import { ProcellaLogo } from "./ProcellaLogo";

/** Descope-only nav items — only rendered inside AuthProvider. */
function DescopeNav() {
	const { sessionToken } = useSession();
	const isAdmin = (() => {
		if (!sessionToken) return false;
		const tenantId = getCurrentTenant(sessionToken);
		if (!tenantId) return false;
		return getJwtRoles(sessionToken, tenantId).includes("admin");
	})();

	return (
		<>
			<NavLink to="/tokens" className={navLinkClass}>
				Tokens
			</NavLink>
			{isAdmin && (
				<NavLink to="/settings" className={navLinkClass}>
					Settings
				</NavLink>
			)}
		</>
	);
}

function navLinkClass({ isActive }: { isActive: boolean }) {
	return `px-3 py-1.5 rounded-md text-sm transition-colors ${
		isActive
			? "bg-slate-brand text-mist font-medium"
			: "text-cloud hover:text-mist hover:bg-slate-brand/50"
	}`;
}

export function Layout() {
	const { config } = useAuthConfig();

	return (
		<div className="min-h-screen flex flex-col bg-deep-sky">
			<header className="border-b border-slate-brand/60 sticky top-0 z-10 backdrop-blur-md bg-deep-sky/80">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
					<div className="flex items-center gap-6">
						<ProcellaLogo
							size="sm"
							linkTo="/"
							className="text-mist hover:text-white transition-colors"
						/>
						<nav className="hidden sm:flex items-center gap-1">
							<NavLink to="/" end className={navLinkClass}>
								Stacks
							</NavLink>

							{config?.mode === "descope" && <DescopeNav />}
							<NavLink to="/webhooks" className={navLinkClass}>
								Webhooks
							</NavLink>
						</nav>
					</div>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={openCommandBar}
							className="flex items-center gap-1.5 rounded-md border border-slate-brand px-2 py-1 text-xs text-cloud transition-colors hover:border-cloud/50 hover:text-mist"
						>
							<span>Search</span>
							<kbd className="font-mono text-xs">⌘K</kbd>
						</button>
						{config?.mode === "descope" ? <DescopeUserMenu /> : <DevTokenInput />}
					</div>
				</div>
			</header>
			<main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<Outlet />
			</main>
			<CommandBar />
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
				className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-lightning focus:ring-offset-2 focus:ring-offset-deep-sky"
			>
				<span className="h-8 w-8 rounded-full bg-lightning flex items-center justify-center text-xs font-semibold text-deep-sky select-none">
					{initials}
				</span>
			</button>

			{open && (
				<div className="absolute right-0 mt-2 w-56 rounded-lg bg-slate-brand border border-cloud/30 shadow-xl py-1 z-50">
					<div className="px-4 py-3 border-b border-cloud/30">
						<p className="text-sm font-medium text-mist truncate">{displayName}</p>
						{user.email && <p className="text-xs text-cloud truncate mt-0.5">{user.email}</p>}
					</div>
					<button
						type="button"
						onClick={handleLogout}
						className="w-full text-left px-4 py-2 text-sm text-mist/80 hover:bg-slate-brand hover:text-white transition-colors"
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
		let savedToken = localStorage.getItem("procella-token");
		if (!savedToken) {
			const legacyToken = localStorage.getItem("strata-token");
			if (legacyToken) {
				savedToken = legacyToken;
				localStorage.setItem("procella-token", legacyToken);
				localStorage.removeItem("strata-token");
			}
		}
		if (savedToken) {
			setToken(savedToken);
		}
	}, []);

	const handleTokenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newToken = e.target.value;
		setToken(newToken);
		localStorage.setItem("procella-token", newToken);
	};

	return (
		<div className="flex items-center gap-3">
			<label htmlFor="token" className="text-sm font-medium text-cloud">
				Token
			</label>
			<input
				id="token"
				type="password"
				value={token}
				onChange={handleTokenChange}
				placeholder="Enter API token..."
				className="bg-slate-brand border border-cloud/30 rounded-md px-3 py-1.5 text-sm text-mist focus:outline-none focus:ring-2 focus:ring-lightning focus:border-transparent w-64 transition-all"
			/>
		</div>
	);
}
