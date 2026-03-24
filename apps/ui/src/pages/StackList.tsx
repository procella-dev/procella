import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { StackCard, type UpdateStatus } from "../components/ui";
import { apiBase } from "../config";
import { trpc } from "../trpc";

type SortBy = "name" | "lastUpdated" | "created";
type SortOrder = "asc" | "desc";

function useDebounce<T>(value: T, delay: number): T {
	const [debouncedValue, setDebouncedValue] = useState<T>(value);

	useEffect(() => {
		const handler = setTimeout(() => setDebouncedValue(value), delay);
		return () => clearTimeout(handler);
	}, [value, delay]);

	return debouncedValue;
}

export function StackList() {
	const [searchText, setSearchText] = useState("");
	const [project, setProject] = useState("");
	const [tagName, setTagName] = useState("");
	const [tagValue, setTagValue] = useState("");
	const [sortBy, setSortBy] = useState<SortBy>("name");
	const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

	const debouncedSearch = useDebounce(searchText, 300);

	const hasFilters = debouncedSearch !== "" || project !== "" || tagName !== "" || tagValue !== "";

	const queryInput =
		hasFilters || sortBy !== "name" || sortOrder !== "asc"
			? {
					query: debouncedSearch || undefined,
					project: project || undefined,
					tagName: tagName || undefined,
					tagValue: tagValue || undefined,
					sortBy,
					sortOrder,
					pageSize: 50,
				}
			: undefined;

	const {
		data: stacks,
		isLoading: loading,
		error: queryError,
	} = trpc.stacks.list.useQuery(queryInput, { refetchInterval: 5000 });
	const error = queryError?.message ?? null;

	// Pagination state
	const [allItems, setAllItems] = useState<StackItem[]>([]);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const prevTokenRef = useRef<string | undefined>(undefined);

	// Reset accumulated items when filters change
	useEffect(() => {
		if (stacks) {
			setAllItems(stacks.stacks ?? []);
			prevTokenRef.current = undefined;
		}
	}, [stacks]);

	const continuationToken = stacks?.continuationToken;

	const loadMore = useCallback(() => {
		if (!continuationToken || isLoadingMore) return;
		setIsLoadingMore(true);
		prevTokenRef.current = continuationToken;
	}, [continuationToken, isLoadingMore]);

	// Fetch next page when loadMore is triggered
	const nextPageInput = prevTokenRef.current
		? {
				query: debouncedSearch || undefined,
				project: project || undefined,
				tagName: tagName || undefined,
				tagValue: tagValue || undefined,
				sortBy,
				sortOrder,
				pageSize: 50,
				continuationToken: prevTokenRef.current,
			}
		: undefined;
	const { data: nextPage } = trpc.stacks.list.useQuery(nextPageInput, {
		enabled: !!nextPageInput && isLoadingMore,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (nextPage && isLoadingMore) {
			setAllItems((prev) => [...prev, ...(nextPage.stacks ?? [])]);
			setIsLoadingMore(false);
			prevTokenRef.current = undefined;
		}
	}, [nextPage, isLoadingMore]);

	const clearFilters = () => {
		setSearchText("");
		setProject("");
		setTagName("");
		setTagValue("");
		setSortBy("name");
		setSortOrder("asc");
	};

	const toggleSortOrder = () => {
		setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
	};

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
				<div className="bg-red-950/30 border border-red-900/40 text-red-400 p-4 rounded-xl text-sm">
					{error}
				</div>
			</div>
		);
	}

	const items = allItems.length > 0 ? allItems : (stacks?.stacks ?? []);
	const hasNoStacks = !hasFilters && items.length === 0;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				{items.length > 0 && (
					<span className="text-xs text-cloud tabular-nums">
						{items.length} stack{items.length !== 1 ? "s" : ""}
					</span>
				)}
			</div>

			{/* Search bar */}
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
						<input
							type="text"
							value={searchText}
							onChange={(e) => setSearchText(e.target.value)}
							placeholder="Search stacks..."
							className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
						/>
					</div>

					{/* Filter row */}
					<div className="flex flex-wrap items-center gap-3">
						<input
							type="text"
							value={project}
							onChange={(e) => setProject(e.target.value)}
							placeholder="Filter by project..."
							className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500 w-48"
						/>
						<input
							type="text"
							value={tagName}
							onChange={(e) => setTagName(e.target.value)}
							placeholder="Tag name..."
							className="bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500 w-36"
						/>
						<input
							type="text"
							value={tagValue}
							onChange={(e) => setTagValue(e.target.value)}
							placeholder="Tag value..."
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
								onClick={toggleSortOrder}
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
				<>
					<StackTable items={items} />
					{continuationToken && !isLoadingMore && (
						<div className="flex justify-center">
							<button
								type="button"
								onClick={loadMore}
								className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
							>
								Load more
							</button>
						</div>
					)}
					{isLoadingMore && (
						<div className="flex justify-center">
							<div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
						</div>
					)}
				</>
			)}
		</div>
	);
}

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
			{/* Getting started card */}
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
								command={`pulumi login ${apiBase || window.location.origin}`}
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

			{/* Quick reference cards */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<QuickRefCard
					title="API Token Authentication"
					description="Use your API token to authenticate the CLI."
					code={`export PULUMI_ACCESS_TOKEN=<your-token>\npulumi login ${apiBase || window.location.origin}`}
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

interface StackItem {
	orgName: string;
	projectName: string;
	stackName: string;
	version: number;
	activeUpdate: boolean;
	currentOperation: string | null;
	tags: Record<string, string>;
}

function StackTable({ items }: { items: StackItem[] }) {
	const queryClient = useQueryClient();
	const utils = trpc.useUtils();

	const handleMouseEnter = (stack: StackItem) => {
		queryClient.prefetchQuery({
			queryKey: getQueryKey(
				trpc.stacks.detail,
				{ org: stack.orgName, project: stack.projectName, stack: stack.stackName },
				"query",
			),
			queryFn: () =>
				utils.stacks.detail.fetch({
					org: stack.orgName,
					project: stack.projectName,
					stack: stack.stackName,
				}),
			staleTime: 10_000,
		});
	};

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
}
