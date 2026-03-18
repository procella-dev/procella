import { Link, useParams, useSearchParams } from "react-router";
import { trpc } from "../trpc";

// ============================================================================
// Helpers
// ============================================================================

/** Shorten a resource type for display (e.g., "aws:s3/bucket:Bucket" → "s3/bucket:Bucket"). */
function shortType(type: string) {
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}

function formatTimestamp(ts: string | null) {
	if (!ts) return null;
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return ts;
	}
}

// ============================================================================
// Property Value Renderer
// ============================================================================

function PropertyValue({ value }: { value: unknown }) {
	if (value === "[secret]") {
		return (
			<span className="px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 text-xs border border-amber-900/50 font-mono">
				[secret]
			</span>
		);
	}

	if (value === null || value === undefined) {
		return <span className="text-zinc-600 italic">null</span>;
	}

	if (typeof value === "boolean") {
		return <span className={value ? "text-green-400" : "text-zinc-500"}>{String(value)}</span>;
	}

	if (typeof value === "number") {
		return <span className="text-blue-400">{String(value)}</span>;
	}

	if (typeof value === "string") {
		if (value.length > 120) {
			return (
				<span className="text-zinc-300 break-all" title={value}>
					{value.slice(0, 120)}…
				</span>
			);
		}
		return <span className="text-zinc-300 break-all">{value}</span>;
	}

	if (typeof value === "object") {
		const json = JSON.stringify(value, null, 2);
		if (json.length > 200) {
			return (
				<details className="inline">
					<summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 text-xs">
						{Array.isArray(value)
							? `Array(${value.length})`
							: `Object(${Object.keys(value).length})`}
					</summary>
					<pre className="mt-1 text-xs text-zinc-400 bg-zinc-950 rounded p-2 overflow-x-auto max-h-48 border border-zinc-800">
						{json}
					</pre>
				</details>
			);
		}
		return <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-all">{json}</pre>;
	}

	return <span className="text-zinc-400">{String(value)}</span>;
}

// ============================================================================
// Property Table
// ============================================================================

function PropertyTable({
	title,
	properties,
	emptyMessage,
}: {
	title: string;
	properties: Record<string, unknown>;
	emptyMessage: string;
}) {
	const entries = Object.entries(properties);

	return (
		<section>
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
				{entries.length > 0 && (
					<span className="text-xs text-zinc-500">{entries.length} properties</span>
				)}
			</div>

			{entries.length === 0 ? (
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-6 text-center">
					<p className="text-zinc-500 text-sm">{emptyMessage}</p>
				</div>
			) : (
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
					<table className="min-w-full divide-y divide-zinc-800">
						<thead className="bg-zinc-950">
							<tr>
								<th
									scope="col"
									className="px-4 py-2.5 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider w-1/3"
								>
									Key
								</th>
								<th
									scope="col"
									className="px-4 py-2.5 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider"
								>
									Value
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{entries.map(([key, val]) => (
								<tr key={key} className="hover:bg-zinc-800/50 transition-colors">
									<td className="px-4 py-2.5 whitespace-nowrap align-top">
										<span className="font-mono text-sm text-zinc-300">{key}</span>
									</td>
									<td className="px-4 py-2.5 font-mono text-sm">
										<PropertyValue value={val} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

// ============================================================================
// Component
// ============================================================================

export function ResourceDetail() {
	const { org, project, stack } = useParams<{
		org: string;
		project: string;
		stack: string;
	}>();
	const [searchParams] = useSearchParams();
	const urn = searchParams.get("urn") ?? "";

	const enabled = Boolean(org && project && stack && urn);
	const {
		data: resource,
		isLoading,
		error: queryError,
	} = trpc.stacks.resource.useQuery(
		{ org: org ?? "", project: project ?? "", stack: stack ?? "", urn },
		{ enabled },
	);

	const stackPath = `/stacks/${org}/${project}/${stack}`;

	// ── Missing URN ─────────────────────────────────────────────────────────────────────
	if (!urn) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={stackPath} className="text-zinc-400 hover:text-zinc-200 transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">Invalid URL</h1>
				</div>
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-8 text-center">
					<p className="text-zinc-500">
						No resource URN specified. Navigate to a resource from the stack detail page.
					</p>
				</div>
			</div>
		);
	}

	// ── Loading State ────────────────────────────────────────────────────────────────────
	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={stackPath} className="text-zinc-400 hover:text-zinc-200 transition-colors">
						&larr; Back to Stack
					</Link>
					<div className="h-8 w-64 bg-zinc-800 rounded animate-pulse" />
				</div>
				<div className="grid grid-cols-2 gap-4">
					{[1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="h-16 bg-zinc-800/50 rounded-lg border border-zinc-700 animate-pulse"
						/>
					))}
				</div>
				<div className="h-64 bg-zinc-800/50 rounded-lg border border-zinc-700 animate-pulse" />
			</div>
		);
	}

	// ── Error State ─────────────────────────────────────────────────────────────────────
	if (queryError) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={stackPath} className="text-zinc-400 hover:text-zinc-200 transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">Error</h1>
				</div>
				<div className="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg">
					{queryError.message}
				</div>
			</div>
		);
	}

	// ── Not Found ──────────────────────────────────────────────────────
	if (!resource) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={stackPath} className="text-zinc-400 hover:text-zinc-200 transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">Resource Not Found</h1>
				</div>
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-8 text-center">
					<p className="text-zinc-500">The requested resource was not found in this stack.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			{/* ── Header ──────────────────────────────────────────────── */}
			<div>
				<div className="flex items-center gap-4 mb-3">
					<Link to={stackPath} className="text-zinc-400 hover:text-zinc-200 transition-colors">
						&larr; Back to Stack
					</Link>
				</div>
				<div className="flex items-start justify-between">
					<div>
						<h1 className="text-2xl font-bold text-zinc-100 mb-1">{resource.name}</h1>
						<div className="font-mono text-sm text-zinc-500">{resource.type}</div>
					</div>
					<div className="flex gap-2">
						{resource.protect && (
							<span className="px-2 py-1 rounded bg-amber-900/30 text-amber-400 text-xs border border-amber-900/50">
								protected
							</span>
						)}
						{resource.external && (
							<span className="px-2 py-1 rounded bg-indigo-900/30 text-indigo-400 text-xs border border-indigo-900/50">
								external
							</span>
						)}
						{resource.taint && (
							<span className="px-2 py-1 rounded bg-orange-900/30 text-orange-400 text-xs border border-orange-900/50">
								tainted
							</span>
						)}
						{resource.delete && (
							<span className="px-2 py-1 rounded bg-red-900/30 text-red-400 text-xs border border-red-900/50">
								pending delete
							</span>
						)}
						{resource.pendingReplacement && (
							<span className="px-2 py-1 rounded bg-yellow-900/30 text-yellow-400 text-xs border border-yellow-900/50">
								pending replacement
							</span>
						)}
						{resource.retainOnDelete && (
							<span className="px-2 py-1 rounded bg-cyan-900/30 text-cyan-400 text-xs border border-cyan-900/50">
								retain on delete
							</span>
						)}
					</div>
				</div>
			</div>

			{/* ── Metadata Grid ───────────────────────────────────────── */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				{/* Provider */}
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
					<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
						Provider
					</div>
					<div className="text-sm font-medium text-zinc-200">{resource.provider}</div>
				</div>

				{/* Resource ID */}
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
					<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
						Resource ID
					</div>
					{resource.id ? (
						<div className="font-mono text-sm text-zinc-300 truncate" title={resource.id}>
							{resource.id}
						</div>
					) : (
						<div className="text-sm text-zinc-600">-</div>
					)}
				</div>

				{/* Type */}
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
					<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
						Type
					</div>
					<div className="text-sm text-zinc-300">{resource.custom ? "Custom" : "Component"}</div>
				</div>

				{/* Created */}
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
					<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
						Created
					</div>
					<div className="text-sm text-zinc-300">{formatTimestamp(resource.created) ?? "-"}</div>
				</div>
			</div>

			{/* ── URN ──────────────────────────────────────────────────── */}
			<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
				<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">URN</div>
				<div className="font-mono text-sm text-zinc-400 break-all select-all">{resource.urn}</div>
			</div>

			{/* ── Parent ───────────────────────────────────────────────── */}
			{resource.parent && (
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
					<div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
						Parent
					</div>
					<Link
						to={`${stackPath}/resources?urn=${encodeURIComponent(resource.parent.urn)}`}
						className="text-blue-400 hover:text-blue-300 text-sm font-medium"
					>
						{resource.parent.name}
					</Link>
					<div className="font-mono text-xs text-zinc-500 mt-0.5 break-all">
						{resource.parent.urn}
					</div>
				</div>
			)}

			{/* ── Init Errors ──────────────────────────────────────────── */}
			{resource.initErrors.length > 0 && (
				<div className="bg-red-900/10 border border-red-900/50 rounded-lg p-4">
					<div className="text-xs font-medium text-red-400 uppercase tracking-wider mb-2">
						Initialization Errors
					</div>
					<div className="space-y-1.5">
						{resource.initErrors.map((err) => (
							<div key={err} className="text-sm text-red-300 font-mono">
								{err}
							</div>
						))}
					</div>
				</div>
			)}

			{/* ── Outputs ──────────────────────────────────────────────── */}
			<PropertyTable
				title="Outputs"
				properties={resource.outputs}
				emptyMessage="No outputs available."
			/>

			{/* ── Inputs ───────────────────────────────────────────────── */}
			<PropertyTable
				title="Inputs"
				properties={resource.inputs}
				emptyMessage="No inputs recorded."
			/>

			{/* ── Dependencies ─────────────────────────────────────────── */}
			{resource.dependencies.length > 0 && (
				<section>
					<h2 className="text-lg font-semibold text-zinc-100 mb-3">
						Dependencies
						<span className="text-xs text-zinc-500 font-normal ml-2">
							{resource.dependencies.length}
						</span>
					</h2>
					<div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
						{resource.dependencies.map((dep) => (
							<Link
								key={dep.urn}
								to={`${stackPath}/resources?urn=${encodeURIComponent(dep.urn)}`}
								className="flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors"
							>
								<div>
									<span className="text-sm text-zinc-100 font-medium">{dep.name}</span>
									<span className="ml-2 font-mono text-xs text-zinc-500">
										{shortType(dep.type)}
									</span>
								</div>
								<span className="text-zinc-600 text-sm">&rarr;</span>
							</Link>
						))}
					</div>
				</section>
			)}

			{/* ── Children ─────────────────────────────────────────────── */}
			{resource.children.length > 0 && (
				<section>
					<h2 className="text-lg font-semibold text-zinc-100 mb-3">
						Children
						<span className="text-xs text-zinc-500 font-normal ml-2">
							{resource.children.length}
						</span>
					</h2>
					<div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
						{resource.children.map((child) => (
							<Link
								key={child.urn}
								to={`${stackPath}/resources?urn=${encodeURIComponent(child.urn)}`}
								className="flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors"
							>
								<div>
									<span className="text-sm text-zinc-100 font-medium">{child.name}</span>
									<span className="ml-2 font-mono text-xs text-zinc-500">
										{shortType(child.type)}
									</span>
								</div>
								<span className="text-zinc-600 text-sm">&rarr;</span>
							</Link>
						))}
					</div>
				</section>
			)}

			{/* ── Aliases ──────────────────────────────────────────────── */}
			{resource.aliases.length > 0 && (
				<section>
					<h2 className="text-lg font-semibold text-zinc-100 mb-3">
						Aliases
						<span className="text-xs text-zinc-500 font-normal ml-2">
							{resource.aliases.length}
						</span>
					</h2>
					<div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-1.5">
						{resource.aliases.map((alias) => (
							<div key={alias} className="font-mono text-sm text-zinc-400 break-all">
								{alias}
							</div>
						))}
					</div>
				</section>
			)}

			{/* ── Modified ─────────────────────────────────────────────── */}
			{resource.modified && (
				<div className="text-xs text-zinc-600 pt-4 border-t border-zinc-800">
					Last modified: {formatTimestamp(resource.modified)}
				</div>
			)}
		</div>
	);
}
