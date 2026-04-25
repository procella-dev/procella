import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../config";
import { useOrg } from "../hooks/useOrg";
import { getAuthHeaders } from "../trpc";

interface StoredSession {
	sessionId: string;
	expiresAt: string;
}

interface FetchedSession {
	sessionId: string;
	values: Record<string, unknown>;
	expiresAt: string;
	closedAt?: string;
}

interface EscSessionsProps {
	project: string;
	environment: string;
	envId: string;
}

function storageKey(envId: string): string {
	return `esc-sessions-${envId}`;
}

function loadSessions(envId: string): StoredSession[] {
	try {
		const raw = localStorage.getItem(storageKey(envId));
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

function saveSessions(envId: string, sessions: StoredSession[]) {
	localStorage.setItem(storageKey(envId), JSON.stringify(sessions));
}

function isExpired(expiresAt: string): boolean {
	return new Date(expiresAt).getTime() < Date.now();
}

function relativeTime(expiresAt: string): string {
	const diff = new Date(expiresAt).getTime() - Date.now();
	if (diff <= 0) return "expired";
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) return `in ${mins} min`;
	const hours = Math.floor(mins / 60);
	return `in ${hours}h ${mins % 60}m`;
}

export function EscSessions({ project, environment, envId }: EscSessionsProps) {
	const { org } = useOrg();
	const [sessions, setSessions] = useState<StoredSession[]>([]);
	const [fetching, setFetching] = useState<string | null>(null);
	const [fetchResult, setFetchResult] = useState<FetchedSession | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);

	useEffect(() => {
		const stored = loadSessions(envId);
		const active = stored.filter((s) => !isExpired(s.expiresAt));
		if (active.length !== stored.length) {
			saveSessions(envId, active);
		}
		setSessions(active);
	}, [envId]);

	const clearSession = useCallback(
		(sessionId: string) => {
			setSessions((prev) => {
				const next = prev.filter((s) => s.sessionId !== sessionId);
				saveSessions(envId, next);
				return next;
			});
			if (fetchResult?.sessionId === sessionId) {
				setFetchResult(null);
			}
		},
		[envId, fetchResult],
	);

	const fetchSession = useCallback(
		async (sessionId: string) => {
			setFetching(sessionId);
			setFetchError(null);
			setFetchResult(null);
			try {
				const res = await fetch(
					`${apiBase}/api/esc/environments/${encodeURIComponent(org)}/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/open/${encodeURIComponent(sessionId)}`,
					{
						headers: { ...getAuthHeaders(), Accept: "application/vnd.pulumi+8" },
					},
				);
				if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
				const data: FetchedSession = await res.json();
				setFetchResult(data);
			} catch (err: unknown) {
				setFetchError(err instanceof Error ? err.message : "Fetch failed");
			} finally {
				setFetching(null);
			}
		},
		[org, project, environment],
	);

	if (sessions.length === 0) {
		return (
			<div className="text-xs text-cloud/60 text-center py-4">
				No sessions tracked. Open a session from the Resolved Values tab.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="bg-slate-brand/50 border border-slate-brand rounded-xl overflow-hidden">
				{sessions.map((s) => {
					const expired = isExpired(s.expiresAt);
					return (
						<div
							key={s.sessionId}
							className={`flex items-center justify-between px-3 py-2.5 border-b border-slate-brand/40 ${
								expired ? "opacity-40" : ""
							}`}
						>
							<div className="min-w-0">
								<span className="font-mono text-xs text-mist">{s.sessionId.slice(0, 8)}…</span>
								<span className="text-xs text-cloud/60 ml-2">{relativeTime(s.expiresAt)}</span>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<button
									type="button"
									onClick={() => fetchSession(s.sessionId)}
									disabled={expired || fetching === s.sessionId}
									className={`text-xs px-2 py-1 rounded transition-colors ${
										expired
											? "text-cloud/30 cursor-not-allowed"
											: "text-lightning hover:text-lightning/80"
									}`}
								>
									{fetching === s.sessionId ? "…" : "Fetch"}
								</button>
								<button
									type="button"
									onClick={() => clearSession(s.sessionId)}
									className="text-xs text-cloud/40 hover:text-red-400 transition-colors px-2 py-1"
								>
									Clear
								</button>
							</div>
						</div>
					);
				})}
			</div>

			{fetchError && (
				<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-3 rounded-xl text-xs">
					{fetchError}
				</div>
			)}

			{fetchResult && (
				<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3">
					<div className="text-xs text-cloud/60 mb-2">
						Session{" "}
						<span className="font-mono text-cloud">{fetchResult.sessionId.slice(0, 8)}…</span>
						{fetchResult.closedAt && <span className="text-red-400 ml-2">closed</span>}
					</div>
					<pre className="text-xs font-mono text-mist overflow-auto max-h-[200px]">
						{JSON.stringify(fetchResult.values, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

export function useSessionTracker(envId: string) {
	const [, setTick] = useState(0);

	const addSession = useCallback(
		(sessionId: string, expiresAt: string) => {
			const stored = loadSessions(envId);
			if (stored.some((s) => s.sessionId === sessionId)) return;
			saveSessions(envId, [{ sessionId, expiresAt }, ...stored]);
			setTick((t) => t + 1);
		},
		[envId],
	);

	return { addSession };
}
