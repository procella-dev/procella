import { useCallback, useState } from "react";
import { apiBase } from "../config";
import { useOrg } from "../hooks/useOrg";
import { getAuthHeaders } from "../trpc";

interface OpenSessionResponse {
	sessionId: string;
	values: Record<string, unknown>;
	secrets: string[];
	expiresAt: string;
}

interface Diagnostic {
	severity: string;
	summary: string;
	path?: string[];
}

interface EscResolvedValuesProps {
	project: string;
	environment: string;
	onSessionOpened?: (sessionId: string, expiresAt: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSecretPath(path: string, secrets: string[]): boolean {
	return secrets.some((s) => s === path || path.startsWith(`${s}.`) || path.startsWith(`${s}[`));
}

function ValueNode({
	path,
	value,
	secrets,
	revealed,
	onReveal,
	depth,
}: {
	path: string;
	value: unknown;
	secrets: string[];
	revealed: Set<string>;
	onReveal: (path: string) => void;
	depth: number;
}) {
	const [expanded, setExpanded] = useState(depth < 2);
	const masked = isSecretPath(path, secrets) && !revealed.has(path);

	if (masked) {
		return (
			<span className="inline-flex items-center gap-2">
				<span className="text-cloud/50 font-mono">••••••••</span>
				<button
					type="button"
					onClick={() => onReveal(path)}
					className="text-[10px] text-lightning hover:text-lightning/80 transition-colors"
				>
					Reveal
				</button>
			</span>
		);
	}

	if (isRecord(value)) {
		const entries = Object.entries(value);
		return (
			<div className={depth > 0 ? "ml-4" : ""}>
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="text-cloud/60 hover:text-cloud text-xs select-none"
				>
					{expanded ? "▾" : "▸"} {`{${entries.length}}`}
				</button>
				{expanded && (
					<div className="ml-2 border-l border-zinc-700/40 pl-3">
						{entries.map(([k, v]) => (
							<div key={k} className="py-0.5">
								<span className="text-lightning/80 text-xs font-mono">{k}</span>
								<span className="text-cloud/40 mx-1">:</span>
								<ValueNode
									path={path ? `${path}.${k}` : k}
									value={v}
									secrets={secrets}
									revealed={revealed}
									onReveal={onReveal}
									depth={depth + 1}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		);
	}

	if (Array.isArray(value)) {
		return (
			<div className={depth > 0 ? "ml-4" : ""}>
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="text-cloud/60 hover:text-cloud text-xs select-none"
				>
					{expanded ? "▾" : "▸"} [{value.length}]
				</button>
				{expanded && (
					<div className="ml-2 border-l border-zinc-700/40 pl-3">
						{value.map((item, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: array items have no stable ID
							<div key={`${path}[${i}]`} className="py-0.5">
								<span className="text-cloud/40 text-xs font-mono">{i}</span>
								<span className="text-cloud/40 mx-1">:</span>
								<ValueNode
									path={`${path}[${i}]`}
									value={item}
									secrets={secrets}
									revealed={revealed}
									onReveal={onReveal}
									depth={depth + 1}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		);
	}

	const display = value === null ? "null" : String(value);
	const color =
		typeof value === "string"
			? "text-emerald-300"
			: typeof value === "number"
				? "text-flash"
				: typeof value === "boolean"
					? "text-purple-300"
					: "text-cloud/60";

	return (
		<span className="inline-flex items-center gap-2">
			<span className={`font-mono text-xs ${color}`}>
				{typeof value === "string" ? `"${display}"` : display}
			</span>
			{isSecretPath(path, secrets) && <CopyButton value={display} />}
		</span>
	);
}

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
			className="text-[10px] text-cloud/40 hover:text-cloud transition-colors"
		>
			{copied ? "✓" : "Copy"}
		</button>
	);
}

export function EscResolvedValues({
	project,
	environment,
	onSessionOpened,
}: EscResolvedValuesProps) {
	const { org } = useOrg();
	const [session, setSession] = useState<OpenSessionResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const [confirmPath, setConfirmPath] = useState<string | null>(null);

	const openSession = useCallback(async () => {
		setLoading(true);
		setError(null);
		setDiagnostics([]);
		try {
			const res = await fetch(
				`${apiBase}/api/esc/environments/${encodeURIComponent(org)}/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/open`,
				{
					method: "POST",
					headers: { ...getAuthHeaders(), Accept: "application/vnd.pulumi+8" },
				},
			);
			if (res.status === 422) {
				const body = await res.json();
				setDiagnostics(body.diagnostics ?? []);
				return;
			}
			if (!res.ok) {
				throw new Error(`Failed to open session (${res.status})`);
			}
			const data: OpenSessionResponse = await res.json();
			setSession(data);
			onSessionOpened?.(data.sessionId, data.expiresAt);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : "Failed to open session");
		} finally {
			setLoading(false);
		}
	}, [org, project, environment, onSessionOpened]);

	const handleReveal = useCallback(
		(path: string) => {
			if (confirmPath === path) {
				setRevealed((prev) => new Set(prev).add(path));
				setConfirmPath(null);
			} else {
				setConfirmPath(path);
			}
		},
		[confirmPath],
	);

	if (!session) {
		return (
			<div className="space-y-3">
				{diagnostics.length > 0 && (
					<div className="bg-red-950/30 border border-red-900/40 rounded-xl p-3 space-y-1.5">
						<div className="text-xs font-medium text-red-300">Evaluation failed</div>
						{diagnostics.map((d) => (
							<div
								key={`${d.severity}-${d.summary}`}
								className="text-xs text-red-300/80 flex gap-2"
							>
								<span className="uppercase text-[10px] font-medium text-red-400 shrink-0">
									{d.severity}
								</span>
								<span>
									{d.path && d.path.length > 0 && (
										<span className="text-red-400/60 font-mono">{d.path.join(".")}: </span>
									)}
									{d.summary}
								</span>
							</div>
						))}
					</div>
				)}
				{error && (
					<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-3 rounded-xl text-sm">
						{error}
					</div>
				)}
				<button
					type="button"
					onClick={openSession}
					disabled={loading}
					className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
						loading
							? "bg-slate-brand text-cloud/50 cursor-not-allowed"
							: "bg-lightning text-deep-sky hover:bg-lightning/90"
					}`}
				>
					{loading ? "Opening…" : "Open Session"}
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-xs text-cloud/60">
					Session <span className="font-mono text-cloud">{session.sessionId.slice(0, 8)}…</span>
					{" · Expires "}
					<span className="text-cloud">{new Date(session.expiresAt).toLocaleTimeString()}</span>
				</div>
			</div>

			{confirmPath && (
				<div className="bg-flash/10 border border-flash/20 rounded-lg px-3 py-2 text-xs text-flash flex items-center justify-between">
					<span>
						Reveal secret <span className="font-mono">{confirmPath}</span>?
					</span>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => handleReveal(confirmPath)}
							className="text-flash hover:text-white transition-colors font-medium"
						>
							Confirm
						</button>
						<button
							type="button"
							onClick={() => setConfirmPath(null)}
							className="text-cloud hover:text-mist transition-colors"
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 overflow-auto max-h-[400px]">
				<ValueNode
					path=""
					value={session.values}
					secrets={session.secrets}
					revealed={revealed}
					onReveal={handleReveal}
					depth={0}
				/>
			</div>
		</div>
	);
}
