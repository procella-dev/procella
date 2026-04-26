import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc";

// ============================================================================
// Types
// ============================================================================

interface EnvRow {
	projectName: string;
	envName: string;
	revision: number;
	updatedAt: Date;
	createdBy: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(date: Date): string {
	return new Date(date).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// ============================================================================
// Debounced input — manages its own text state, notifies parent after delay
// ============================================================================

const DebouncedInput = memo(function DebouncedInput({
	onCommit,
	placeholder,
	className,
	delay = 200,
}: {
	onCommit: (value: string) => void;
	placeholder: string;
	className?: string;
	delay?: number;
}) {
	const [text, setText] = useState("");
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	return (
		<input
			type="text"
			value={text}
			onChange={(e) => {
				const val = e.target.value;
				setText(val);
				clearTimeout(timerRef.current);
				timerRef.current = setTimeout(() => commitRef.current(val), delay);
			}}
			placeholder={placeholder}
			className={
				className ??
				"w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
			}
		/>
	);
});

// ============================================================================
// Environment table
// ============================================================================

const EnvTable = memo(function EnvTable({ items }: { items: EnvRow[] }) {
	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl overflow-hidden">
			<div className="grid grid-cols-[1fr_1.5fr_0.5fr_1fr_1fr] gap-4 px-4 py-2.5 border-b border-slate-brand text-xs font-medium text-cloud/70 uppercase tracking-wider">
				<span>Project</span>
				<span>Name</span>
				<span>Rev</span>
				<span>Updated</span>
				<span>Created By</span>
			</div>
			{items.map((env, index) => (
				<Link
					key={`${env.projectName}/${env.envName}`}
					to={`/esc/${encodeURIComponent(env.projectName)}/${encodeURIComponent(env.envName)}`}
					className={`grid grid-cols-[1fr_1.5fr_0.5fr_1fr_1fr] gap-4 px-4 py-3 hover:bg-slate-brand/80 transition-colors text-sm ${
						index < items.length - 1 ? "border-b border-slate-brand/40" : ""
					}`}
				>
					<span className="text-cloud truncate">{env.projectName}</span>
					<span className="text-mist font-medium truncate">{env.envName}</span>
					<span className="text-cloud font-mono text-xs">#{env.revision}</span>
					<span className="text-cloud text-xs">{formatDate(env.updatedAt)}</span>
					<span className="text-cloud text-xs truncate">{env.createdBy}</span>
				</Link>
			))}
		</div>
	);
});

// ============================================================================
// Main component
// ============================================================================

export function EscEnvironments() {
	const [search, setSearch] = useState("");
	const [allEnvs, setAllEnvs] = useState<EnvRow[]>([]);
	const [envsLoading, setEnvsLoading] = useState(true);
	const [fetchErrors, setFetchErrors] = useState<string[]>([]);
	const utils = trpc.useUtils();

	const {
		data: projects,
		isLoading: projectsLoading,
		error: queryError,
	} = trpc.esc.listProjects.useQuery(undefined, { refetchInterval: 10_000 });
	const error = queryError?.message ?? null;

	const fetchEnvs = useCallback(async () => {
		if (!projects) return;
		if (projects.length === 0) {
			setAllEnvs([]);
			setFetchErrors([]);
			setEnvsLoading(false);
			return;
		}
		setEnvsLoading(true);
		const errors: string[] = [];
		try {
			const results = await Promise.all(
				projects.map(async (p) => {
					try {
						const envs = await utils.esc.listEnvironments.fetch({ project: p.name });
						return envs.map((e) => ({
							projectName: p.name,
							envName: e.name,
							revision: e.currentRevisionNumber,
							updatedAt: e.updatedAt,
							createdBy: e.createdBy,
						}));
					} catch {
						errors.push(p.name);
						return [];
					}
				}),
			);
			setAllEnvs(results.flat());
			setFetchErrors(errors);
		} finally {
			setEnvsLoading(false);
		}
	}, [projects, utils]);

	useEffect(() => {
		fetchEnvs();
	}, [fetchEnvs]);

	const loading = projectsLoading || envsLoading;

	const filtered = search
		? allEnvs.filter(
				(e) =>
					e.projectName.toLowerCase().includes(search.toLowerCase()) ||
					e.envName.toLowerCase().includes(search.toLowerCase()),
			)
		: allEnvs;

	if (loading && allEnvs.length === 0) {
		return (
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<h1 className="text-xl font-semibold text-mist">Environments</h1>
				</div>
				<div className="animate-pulse space-y-3">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-[52px] bg-slate-brand rounded-xl border border-slate-brand" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-xl font-semibold text-mist">Environments</h1>
				<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-4 rounded-xl text-sm">
					{error}
				</div>
			</div>
		);
	}

	const hasNoEnvs = allEnvs.length === 0;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold text-mist">Environments</h1>
				<span className="text-xs text-cloud tabular-nums">
					{allEnvs.length > 0 && `${allEnvs.length} environment${allEnvs.length !== 1 ? "s" : ""}`}
				</span>
			</div>

			{fetchErrors.length > 0 && (
				<div className="bg-flash/10 border border-flash/20 text-flash p-3 rounded-xl text-sm">
					Could not load environments for: {fetchErrors.join(", ")}
				</div>
			)}

			{!hasNoEnvs && (
				<div className="relative">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
						/>
					</svg>
					<DebouncedInput
						onCommit={setSearch}
						placeholder="Search environments..."
						className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
					/>
				</div>
			)}

			{hasNoEnvs ? (
				<EscEmptyState />
			) : filtered.length === 0 && search ? (
				<EmptySearchState />
			) : (
				<EnvTable items={filtered} />
			)}
		</div>
	);
}

// ============================================================================
// Empty states
// ============================================================================

function EmptySearchState() {
	return (
		<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-10 h-10 text-zinc-600 mx-auto mb-3"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
				/>
			</svg>
			<p className="text-zinc-400 text-sm font-medium mb-1">No environments match your search</p>
			<p className="text-zinc-500 text-xs">Try a different search term.</p>
		</div>
	);
}

function EscEmptyState() {
	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl p-8">
			<div className="flex items-start gap-4">
				<div className="w-10 h-10 rounded-lg bg-lightning/10 border border-lightning/20 flex items-center justify-center shrink-0">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						className="w-5 h-5 text-lightning"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z"
						/>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
				</div>
				<div>
					<h3 className="text-sm font-semibold text-mist mb-1.5">No environments yet</h3>
					<p className="text-sm text-cloud leading-relaxed mb-4">
						Create your first ESC environment to manage configuration and secrets.
					</p>
					<div className="bg-deep-sky border border-slate-brand rounded-lg px-3 py-2 font-mono text-xs text-mist/80">
						<span className="text-emerald-400 mr-1.5 select-none">$</span>
						esc env init myproject/dev --value greeting=hello
					</div>
				</div>
			</div>
		</div>
	);
}
