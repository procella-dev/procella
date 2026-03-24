import { Link, useParams } from "react-router";
import { trpc } from "../trpc";

// ============================================================================
// Helpers
// ============================================================================

function getResultColor(result: string) {
	switch (result) {
		case "succeeded":
			return "bg-green-900/30 text-green-400 border-green-900/50";
		case "failed":
			return "bg-red-900/30 text-red-400 border-red-900/50";
		case "in-progress":
			return "bg-yellow-900/30 text-yellow-400 border-yellow-900/50";
		case "cancelled":
			return "bg-slate-brand text-cloud border-cloud/30";
		default:
			return "bg-slate-brand text-cloud border-cloud/30";
	}
}

function getKindColor(kind: string) {
	switch (kind) {
		case "update":
			return "bg-lightning/10 text-lightning border-lightning/20";
		case "preview":
			return "bg-purple-900/30 text-purple-400 border-purple-900/50";
		case "destroy":
			return "bg-red-900/30 text-red-400 border-red-900/50";
		case "refresh":
			return "bg-teal-900/30 text-teal-400 border-teal-900/50";
		case "import":
			return "bg-cyan-900/30 text-cyan-400 border-cyan-900/50";
		default:
			return "bg-slate-brand text-cloud border-cloud/30";
	}
}

function getOpColor(op: string) {
	switch (op) {
		case "create":
			return "text-green-400";
		case "update":
			return "text-yellow-400";
		case "delete":
			return "text-red-400";
		case "same":
			return "text-cloud";
		case "replace":
			return "text-orange-400";
		default:
			return "text-lightning";
	}
}

function formatDuration(start: number, end: number) {
	if (!start || !end) return null;
	const seconds = end - start;
	if (seconds < 60) return `${String(seconds)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${String(mins)}m ${String(secs)}s`;
}

function formatDate(timestamp: number) {
	if (!timestamp) return "-";
	return new Date(timestamp * 1000).toLocaleString();
}

function formatRelativeTime(timestamp: number) {
	if (!timestamp) return "-";
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
	return new Date(timestamp * 1000).toLocaleDateString();
}

/** Truncate a string in the middle for display. */
function truncateMiddle(str: string, maxLen: number) {
	if (str.length <= maxLen) return str;
	const half = Math.floor((maxLen - 3) / 2);
	return `${str.slice(0, half)}…${str.slice(-half)}`;
}

/** Shorten a resource type for display (e.g., "aws:s3/bucket:Bucket" → "s3/bucket:Bucket"). */
function shortType(type: string) {
	// Remove provider prefix for readability (keep module:Type)
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}

// ============================================================================
// Component
// ============================================================================

export function StackDetail() {
	const { org, project, stack } = useParams<{ org: string; project: string; stack: string }>();
	const enabled = Boolean(org && project && stack);
	const params = { org: org ?? "", project: project ?? "", stack: stack ?? "" };

	const {
		data: detail,
		isLoading: detailLoading,
		error: detailError,
	} = trpc.stacks.detail.useQuery(params, { enabled });
	const {
		data: resources,
		isLoading: resourcesLoading,
		error: resourcesError,
	} = trpc.stacks.resources.useQuery(params, { enabled });
	const {
		data: updates,
		isLoading: updatesLoading,
		error: updatesError,
	} = trpc.updates.list.useQuery(params, { enabled });

	const isLoading = detailLoading || updatesLoading;

	// ── Loading State ──────────────────────────────────────────────────
	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to="/" className="text-cloud hover:text-mist transition-colors">
						&larr; Back
					</Link>
					<div className="h-8 w-48 bg-slate-brand rounded animate-pulse" />
				</div>
				<div className="grid grid-cols-3 gap-4">
					{[1, 2, 3].map((i) => (
						<div
							key={i}
							className="h-24 bg-slate-brand/50 rounded-lg border border-cloud/30 animate-pulse"
						/>
					))}
				</div>
				<div className="h-64 bg-slate-brand/50 rounded-lg border border-cloud/30 animate-pulse" />
			</div>
		);
	}

	// ── Error State ────────────────────────────────────────────────────────────────────
	const queryError = detailError ?? updatesError ?? resourcesError;
	if (queryError) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to="/" className="text-cloud hover:text-mist">
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-mist">
						{org}/{project}/{stack}
					</h1>
				</div>
				<div className="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg">
					{queryError.message}
				</div>
			</div>
		);
	}

	const updateItems = updates ?? [];
	const resourceItems = resources ?? [];
	const lastUpdate = detail?.lastUpdate ?? null;

	return (
		<div className="space-y-8">
			{/* ── Header ──────────────────────────────────────────────── */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Link to="/" className="text-cloud hover:text-mist transition-colors">
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-mist">
						<span className="text-cloud font-normal">
							{org} / {project} /{" "}
						</span>
						{stack}
					</h1>
				</div>
				{detail?.activeUpdate && (
					<span className="flex items-center gap-2 text-sm text-yellow-400">
						<span className="relative flex h-2.5 w-2.5">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
							<span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-500" />
						</span>
						Update in progress
					</span>
				)}
			</div>

			{/* ── Overview Cards ───────────────────────────────────────── */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				{/* Version */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-5">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-2">
						Version
					</div>
					<div className="text-2xl font-bold text-mist">v{detail?.version ?? 0}</div>
				</div>

				{/* Resources */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-5">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-2">
						Resources
					</div>
					<div className="text-2xl font-bold text-mist">
						{resourcesLoading ? (
							<span className="inline-block h-7 w-12 bg-slate-brand rounded animate-pulse" />
						) : (
							resourceItems.length
						)}
					</div>
				</div>

				{/* Last Update */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-5">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-2">
						Last Update
					</div>
					{lastUpdate ? (
						<div className="flex items-center gap-3">
							<span
								className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getResultColor(lastUpdate.result)}`}
							>
								{lastUpdate.result || "unknown"}
							</span>
							<span className="text-sm text-cloud">
								{formatRelativeTime(lastUpdate.endTime || lastUpdate.startTime)}
							</span>
						</div>
					) : (
						<div className="text-sm text-cloud">No updates yet</div>
					)}
				</div>
			</div>

			{/* ── Tags ─────────────────────────────────────────────────── */}
			{detail?.tags && Object.keys(detail.tags).length > 0 && (
				<div className="flex flex-wrap gap-2">
					{Object.entries(detail.tags).map(([k, v]) => (
						<span
							key={k}
							className="px-2.5 py-1 bg-slate-brand/80 rounded-md text-xs border border-cloud/30 text-cloud"
						>
							<span className="text-cloud">{k}:</span> {v}
						</span>
					))}
				</div>
			)}

			{/* ── Resources Table ──────────────────────────────────────── */}
			<section>
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-lg font-semibold text-mist">Resources</h2>
					{resourceItems.length > 0 && (
						<span className="text-xs text-cloud">{resourceItems.length} resources</span>
					)}
				</div>

				{resourcesLoading ? (
					<div className="bg-slate-brand border border-slate-brand rounded-lg overflow-hidden">
						<div className="animate-pulse space-y-0">
							{[1, 2, 3, 4].map((i) => (
								<div key={i} className="h-12 border-b border-slate-brand last:border-0" />
							))}
						</div>
					</div>
				) : resourceItems.length === 0 ? (
					<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
						<p className="text-cloud">
							No resources.{" "}
							<code className="bg-slate-brand px-1.5 py-0.5 rounded text-sm">pulumi up</code> to
							deploy.
						</p>
					</div>
				) : (
					<div className="bg-slate-brand border border-slate-brand rounded-lg overflow-hidden">
						<table className="min-w-full divide-y divide-slate-brand">
							<thead className="bg-deep-sky">
								<tr>
									<th
										scope="col"
										className="px-4 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
									>
										Type
									</th>
									<th
										scope="col"
										className="px-4 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
									>
										Name
									</th>
									<th
										scope="col"
										className="px-4 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider hidden md:table-cell"
									>
										Provider
									</th>
									<th
										scope="col"
										className="px-4 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider hidden lg:table-cell"
									>
										ID
									</th>
									<th
										scope="col"
										className="px-4 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider hidden lg:table-cell"
									>
										Flags
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-slate-brand bg-slate-brand">
								{resourceItems.map((r) => (
									<tr
										key={r.urn}
										className="hover:bg-slate-brand/50 transition-colors cursor-pointer group"
									>
										<td className="px-4 py-3 whitespace-nowrap">
											<span className="font-mono text-sm text-mist/80" title={r.type}>
												{shortType(r.type)}
											</span>
										</td>
										<td className="px-4 py-3 whitespace-nowrap">
											<Link
												to={`/stacks/${org}/${project}/${stack}/resources?urn=${encodeURIComponent(r.urn)}`}
												className="text-sm text-lightning hover:text-lightning/80 font-medium group-hover:underline"
											>
												{r.name}
											</Link>
											{r.parent && <span className="ml-2 text-xs text-cloud/60">← {r.parent}</span>}
										</td>
										<td className="px-4 py-3 whitespace-nowrap hidden md:table-cell">
											<span className="px-2 py-0.5 rounded bg-slate-brand text-xs text-cloud border border-cloud/30">
												{r.provider}
											</span>
										</td>
										<td className="px-4 py-3 whitespace-nowrap hidden lg:table-cell">
											{r.id ? (
												<span className="font-mono text-xs text-cloud" title={r.id}>
													{truncateMiddle(r.id, 24)}
												</span>
											) : (
												<span className="text-xs text-cloud/60">-</span>
											)}
										</td>
										<td className="px-4 py-3 whitespace-nowrap hidden lg:table-cell">
											<div className="flex gap-1.5">
												{r.protect && (
													<span className="px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 text-xs border border-amber-900/50">
														protected
													</span>
												)}
												{r.external && (
													<span className="px-1.5 py-0.5 rounded bg-indigo-900/30 text-indigo-400 text-xs border border-indigo-900/50">
														external
													</span>
												)}
												{!r.protect && !r.external && (
													<span className="text-xs text-cloud/60">-</span>
												)}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{/* ── Update History ────────────────────────────────────────── */}
			<section>
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-lg font-semibold text-mist">Update History</h2>
					{updateItems.length > 0 && (
						<span className="text-xs text-cloud">{updateItems.length} updates</span>
					)}
				</div>

				{updateItems.length === 0 ? (
					<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
						<p className="text-cloud">
							No updates yet. Run{" "}
							<code className="bg-slate-brand px-1.5 py-0.5 rounded text-sm">pulumi up</code> to
							create one.
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{updateItems.map((update) => {
							const duration = formatDuration(update.startTime, update.endTime);
							const changes = Object.entries(update.resourceChanges);

							return (
								<Link
									key={update.updateID}
									to={`/stacks/${org}/${project}/${stack}/updates/${update.updateID}`}
									className="block bg-slate-brand border border-slate-brand rounded-lg p-5 hover:border-cloud/30 transition-colors group"
								>
									<div className="flex items-start justify-between mb-2">
										<div className="flex items-center gap-2.5">
											<span
												className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${getKindColor(update.kind)}`}
											>
												{update.kind}
											</span>
											<span
												className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${getResultColor(update.result)}`}
											>
												{update.result || "pending"}
											</span>
											<span className="text-sm text-cloud">v{update.version}</span>
										</div>
										<div className="text-right text-sm">
											<div className="text-cloud">{formatDate(update.startTime)}</div>
											{duration && <div className="text-cloud/60 text-xs">{duration}</div>}
										</div>
									</div>

									{update.message && (
										<div className="text-cloud text-sm mb-2 truncate">{update.message}</div>
									)}

									{changes.length > 0 && (
										<div className="flex gap-3 text-xs mt-2 pt-2 border-t border-slate-brand/50">
											{changes.map(([op, count]) => (
												<span key={op} className="flex items-center gap-1">
													<span className={`font-bold ${getOpColor(op)}`}>{count}</span>
													<span className="text-cloud">{op}</span>
												</span>
											))}
										</div>
									)}
								</Link>
							);
						})}
					</div>
				)}
			</section>
		</div>
	);
}
