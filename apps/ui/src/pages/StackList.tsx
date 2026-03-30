import { keepPreviousData } from "@tanstack/react-query";
import { memo, useCallback, useRef, useState } from "react";
import { StackCard, type UpdateStatus } from "../components/ui";
import { cliApiUrl } from "../config";
import { trpc } from "../trpc";

type SortBy = "name" | "lastUpdated" | "created";
type SortOrder = "asc" | "desc";

// ============================================================================
// Debounced input — manages its own text state, notifies parent after delay
// ============================================================================

const DebouncedInput = memo(function DebouncedInput({
	onCommit,
	placeholder,
	className,
	delay = 300,
	resetKey,
}: {
	onCommit: (value: string) => void;
	placeholder: string;
	className?: string;
	delay?: number;
	resetKey?: number;
}) {
	const [text, setText] = useState("");
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;

	const prevKeyRef = useRef(resetKey);
	if (resetKey !== prevKeyRef.current) {
		prevKeyRef.current = resetKey;
		setText("");
	}

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
				"bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
			}
		/>
	);
});

// ============================================================================
// Stack table — memoized to avoid rerendering when parent state changes
// ============================================================================

interface StackItem {
	orgName: string;
	projectName: string;
	stackName: string;
	version: number;
	activeUpdate: boolean;
	currentOperation: string | null;
	tags: Record<string, string>;
}

const StackTable = memo(function StackTable({ items }: { items: StackItem[] }) {
	const utils = trpc.useUtils();

	const handleMouseEnter = useCallback(
		(stack: StackItem) => {
			utils.stacks.detail.prefetch({
				org: stack.orgName,
				project: stack.projectName,
				stack: stack.stackName,
			});
		},
		[utils],
	);

	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl overflow-hidden">
			{items.map((stack, index) => {
				const status: UpdateStatus = stack.activeUpdate ? "updating" : "succeeded";
				return (
					<StackCard
						key={`${stack.orgName}/${stack.projectName}/${stack.stackName}`}
						orgName={stack.orgName}
						projectName={stack.projectName}
						stackName={stack.stackName}
						href={`/stacks/${stack.orgName}/${stack.projectName}/${stack.stackName}`}
						lastUpdateStatus={status}
						onHover={() => handleMouseEnter(stack)}
						isFirst={index === 0}
						isLast={index === items.length - 1}
					/>
				);
			})}
		</div>
	);
});

// ============================================================================
// Main component
// ============================================================================

export function StackList() {
	const [query, setQuery] = useState("");
	const [project, setProject] = useState("");
	const [tagName, setTagName] = useState("");
	const [tagValue, setTagValue] = useState("");
	const [sortBy, setSortBy] = useState<SortBy>("name");
	const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
	const [resetKey, setResetKey] = useState(0);

	const hasFilters = query !== "" || project !== "" || tagName !== "" || tagValue !== "";
	const hasNonDefaultSort = sortBy !== "name" || sortOrder !== "asc";

	const queryInput =
		hasFilters || hasNonDefaultSort
			? {
					query: query || undefined,
					project: project || undefined,
					tagName: tagName || undefined,
					tagValue: tagValue || undefined,
					sortBy,
					sortOrder,
					pageSize: 50,
				}
			: undefined;

	const {
		data: page,
		isLoading: initialLoading,
		isFetching,
		error: queryError,
	} = trpc.stacks.list.useQuery(queryInput, {
		refetchInterval: 5000,
		placeholderData: keepPreviousData,
	});
	const error = queryError?.message ?? null;
	const loading = initialLoading && !page;

	const items: StackItem[] = page?.stacks ?? [];

	const clearFilters = useCallback(() => {
		setQuery("");
		setProject("");
		setTagName("");
		setTagValue("");
		setSortBy("name");
		setSortOrder("asc");
		setResetKey((k) => k + 1);
	}, []);

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				</div>
				<div className="animate-pulse space-y-3">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-[72px] bg-slate-brand rounded-xl border border-slate-brand" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-4 rounded-xl text-sm">
					{error}
				</div>
			</div>
		);
	}

	const hasNoStacks = !hasFilters && items.length === 0;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				<span className="text-xs text-cloud tabular-nums">
					{isFetching && hasFilters ? (
						<span className="text-zinc-500">Searching…</span>
					) : (
						items.length > 0 && `${items.length} stack${items.length !== 1 ? "s" : ""}`
					)}
				</span>
			</div>

			{!hasNoStacks && (
				<div className="space-y-3">
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
							onCommit={setQuery}
							placeholder="Search stacks..."
							resetKey={resetKey}
							className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
						/>
					</div>

					<div className="flex flex-wrap items-center gap-3">
						<DebouncedInput
							onCommit={setProject}
							placeholder="Filter by project..."
							resetKey={resetKey}
							className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500 w-48"
						/>
						<DebouncedInput
							onCommit={setTagName}
							placeholder="Tag name..."
							resetKey={resetKey}
							className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500 w-36"
						/>
						<DebouncedInput
							onCommit={setTagValue}
							placeholder="Tag value..."
							resetKey={resetKey}
							className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500 w-36"
						/>

						<div className="flex items-center gap-1.5">
							<select
								value={sortBy}
								onChange={(e) => setSortBy(e.target.value as SortBy)}
								className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							>
								<option value="name">Name</option>
								<option value="lastUpdated">Last Updated</option>
								<option value="created">Created</option>
							</select>
							<button
								type="button"
								onClick={() => setSortOrder((p) => (p === "asc" ? "desc" : "asc"))}
								className="bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-zinc-100 rounded-lg px-2.5 py-2 text-sm transition-colors"
								title={sortOrder === "asc" ? "Ascending" : "Descending"}
							>
								{sortOrder === "asc" ? "↑" : "↓"}
							</button>
						</div>

						{hasFilters && (
							<button
								type="button"
								onClick={clearFilters}
								className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
							>
								Clear filters
							</button>
						)}
					</div>
				</div>
			)}

			{hasNoStacks ? (
				<EmptyState />
			) : items.length === 0 && hasFilters ? (
				<EmptySearchState onClear={clearFilters} />
			) : (
				<StackTable items={items} />
			)}
		</div>
	);
}

// ============================================================================
// Empty states
// ============================================================================

function EmptySearchState({ onClear }: { onClear: () => void }) {
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
			<p className="text-zinc-400 text-sm font-medium mb-1">No stacks match your search</p>
			<p className="text-zinc-500 text-xs mb-4">Try adjusting your filters or search terms.</p>
			<button
				type="button"
				onClick={onClear}
				className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
			>
				Clear filters
			</button>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="space-y-6">
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
								d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"
							/>
						</svg>
					</div>
					<div>
						<h3 className="text-sm font-semibold text-mist mb-1.5">Get started with Procella</h3>
						<p className="text-sm text-cloud leading-relaxed mb-5">
							Connect the Pulumi CLI to this backend and create your first stack.
						</p>
						<div className="space-y-3">
							<CommandStep
								step="1"
								label="Login to this backend"
								command={`pulumi login ${cliApiUrl}`}
							/>
							<CommandStep
								step="2"
								label="Create a stack"
								command="pulumi stack init myorg/myproject/dev"
							/>
							<CommandStep step="3" label="Deploy your infrastructure" command="pulumi up" />
						</div>
					</div>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<QuickRefCard
					title="API Token Authentication"
					description="Use your API token to authenticate the CLI."
					code={`export PULUMI_ACCESS_TOKEN=<your-token>\npulumi login ${cliApiUrl}`}
				/>
				<QuickRefCard
					title="Manage Stacks"
					description="Common stack operations after logging in."
					code="pulumi stack ls          # List all stacks\npulumi stack select dev  # Switch stack\npulumi stack rm dev      # Delete a stack"
				/>
			</div>
		</div>
	);
}

function CommandStep({ step, label, command }: { step: string; label: string; command: string }) {
	return (
		<div className="flex items-start gap-3">
			<span className="w-5 h-5 rounded-full bg-slate-brand border border-cloud/30 flex items-center justify-center text-[10px] font-semibold text-cloud shrink-0 mt-0.5">
				{step}
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-xs text-cloud mb-1">{label}</p>
				<div className="bg-deep-sky border border-slate-brand rounded-lg px-3 py-2 font-mono text-xs text-mist/80 overflow-x-auto">
					<span className="text-emerald-400 mr-1.5 select-none">$</span>
					{command}
				</div>
			</div>
		</div>
	);
}

function QuickRefCard({
	title,
	description,
	code,
}: {
	title: string;
	description: string;
	code: string;
}) {
	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl p-5">
			<h4 className="text-sm font-medium text-mist mb-1">{title}</h4>
			<p className="text-xs text-cloud mb-3">{description}</p>
			<pre className="bg-deep-sky border border-slate-brand rounded-lg px-3 py-2.5 font-mono text-xs text-cloud overflow-x-auto whitespace-pre leading-relaxed">
				{code}
			</pre>
		</div>
	);
}
