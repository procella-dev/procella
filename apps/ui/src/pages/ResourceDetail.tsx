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
		return <span className="text-cloud/60 italic">null</span>;
	}

	if (typeof value === "boolean") {
		return <span className={value ? "text-green-400" : "text-cloud"}>{String(value)}</span>;
	}

	if (typeof value === "number") {
		return <span className="text-lightning">{String(value)}</span>;
	}

	if (typeof value === "string") {
		if (value.length > 120) {
			return (
				<span className="text-mist/80 break-all" title={value}>
					{value.slice(0, 120)}…
				</span>
			);
		}
		return <span className="text-mist/80 break-all">{value}</span>;
	}

	if (typeof value === "object") {
		const json = JSON.stringify(value, null, 2);
		if (json.length > 200) {
			return (
				<details className="inline">
					<summary className="text-cloud cursor-pointer hover:text-mist/80 text-xs">
						{Array.isArray(value)
							? `Array(${value.length})`
							: `Object(${Object.keys(value).length})`}
					</summary>
					<pre className="mt-1 text-xs text-cloud bg-deep-sky rounded p-2 overflow-x-auto max-h-48 border border-slate-brand">
						{json}
					</pre>
				</details>
			);
		}
		return <pre className="text-xs text-cloud whitespace-pre-wrap break-all">{json}</pre>;
	}

	return <span className="text-cloud">{String(value)}</span>;
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
				<h2 className="text-lg font-semibold text-mist">{title}</h2>
				{entries.length > 0 && (
					<span className="text-xs text-cloud">{entries.length} properties</span>
				)}
			</div>

			{entries.length === 0 ? (
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-6 text-center">
					<p className="text-cloud text-sm">{emptyMessage}</p>
				</div>
			) : (
				<div className="bg-slate-brand border border-slate-brand rounded-lg overflow-hidden">
					<table className="min-w-full divide-y divide-slate-brand">
						<thead className="bg-deep-sky">
							<tr>
								<th
									scope="col"
									className="px-4 py-2.5 text-left text-xs font-medium text-cloud uppercase tracking-wider w-1/3"
								>
									Key
								</th>
								<th
									scope="col"
									className="px-4 py-2.5 text-left text-xs font-medium text-cloud uppercase tracking-wider"
								>
									Value
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-brand">
							{entries.map(([key, val]) => (
								<tr key={key} className="hover:bg-slate-brand/50 transition-colors">
									<td className="px-4 py-2.5 whitespace-nowrap align-top">
										<span className="font-mono text-sm text-mist/80">{key}</span>
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
					<Link to={stackPath} className="text-cloud hover:text-mist transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-mist">Invalid URL</h1>
				</div>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-cloud">
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
					<Link to={stackPath} className="text-cloud hover:text-mist transition-colors">
						&larr; Back to Stack
					</Link>
					<div className="h-8 w-64 bg-slate-brand rounded animate-pulse" />
				</div>
				<div className="grid grid-cols-2 gap-4">
					{[1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="h-16 bg-slate-brand/50 rounded-lg border border-cloud/30 animate-pulse"
						/>
					))}
				</div>
				<div className="h-64 bg-slate-brand/50 rounded-lg border border-cloud/30 animate-pulse" />
			</div>
		);
	}

	// ── Error State ─────────────────────────────────────────────────────────────────────
	if (queryError) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={stackPath} className="text-cloud hover:text-mist transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-mist">Error</h1>
				</div>
				<div className="bg-red-900/20 border border-red-900/50 text-red-300 p-4 rounded-lg">
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
					<Link to={stackPath} className="text-cloud hover:text-mist transition-colors">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-mist">Resource Not Found</h1>
				</div>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-cloud">The requested resource was not found in this stack.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			{/* ── Header ──────────────────────────────────────────────── */}
			<div>
				<div className="flex items-center gap-4 mb-3">
					<Link to={stackPath} className="text-cloud hover:text-mist transition-colors">
						&larr; Back to Stack
					</Link>
				</div>
				<div className="flex items-start justify-between">
					<div>
						<h1 className="text-2xl font-bold text-mist mb-1">{resource.name}</h1>
						<div className="font-mono text-sm text-cloud">{resource.type}</div>
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
							<span className="px-2 py-1 rounded bg-red-900/30 text-red-300 text-xs border border-red-900/50">
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
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">
						Provider
					</div>
					<div className="text-sm font-medium text-mist">{resource.provider}</div>
				</div>

				{/* Resource ID */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">
						Resource ID
					</div>
					{resource.id ? (
						<div className="font-mono text-sm text-mist/80 truncate" title={resource.id}>
							{resource.id}
						</div>
					) : (
						<div className="text-sm text-cloud/60">-</div>
					)}
				</div>

				{/* Type */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">Type</div>
					<div className="text-sm text-mist/80">{resource.custom ? "Custom" : "Component"}</div>
				</div>

				{/* Created */}
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">
						Created
					</div>
					<div className="text-sm text-mist/80">{formatTimestamp(resource.created) ?? "-"}</div>
				</div>
			</div>

			{/* ── URN ──────────────────────────────────────────────────── */}
			<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
				<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">URN</div>
				<div className="font-mono text-sm text-cloud break-all select-all">{resource.urn}</div>
			</div>

			{/* ── Parent ───────────────────────────────────────────────── */}
			{resource.parent && (
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-4">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-1.5">
						Parent
					</div>
					<Link
						to={`${stackPath}/resources?urn=${encodeURIComponent(resource.parent.urn)}`}
						className="text-lightning hover:text-lightning/80 text-sm font-medium"
					>
						{resource.parent.name}
					</Link>
					<div className="font-mono text-xs text-cloud mt-0.5 break-all">{resource.parent.urn}</div>
				</div>
			)}

			{/* ── Init Errors ──────────────────────────────────────────── */}
			{resource.initErrors.length > 0 && (
				<div className="bg-red-900/10 border border-red-900/50 rounded-lg p-4">
					<div className="text-xs font-medium text-red-300 uppercase tracking-wider mb-2">
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
					<h2 className="text-lg font-semibold text-mist mb-3">
						Dependencies
						<span className="text-xs text-cloud font-normal ml-2">
							{resource.dependencies.length}
						</span>
					</h2>
					<div className="bg-slate-brand border border-slate-brand rounded-lg divide-y divide-slate-brand">
						{resource.dependencies.map((dep) => (
							<Link
								key={dep.urn}
								to={`${stackPath}/resources?urn=${encodeURIComponent(dep.urn)}`}
								className="flex items-center justify-between px-4 py-3 hover:bg-slate-brand/50 transition-colors"
							>
								<div>
									<span className="text-sm text-mist font-medium">{dep.name}</span>
									<span className="ml-2 font-mono text-xs text-cloud">{shortType(dep.type)}</span>
								</div>
								<span className="text-cloud/60 text-sm">&rarr;</span>
							</Link>
						))}
					</div>
				</section>
			)}

			{/* ── Children ─────────────────────────────────────────────── */}
			{resource.children.length > 0 && (
				<section>
					<h2 className="text-lg font-semibold text-mist mb-3">
						Children
						<span className="text-xs text-cloud font-normal ml-2">{resource.children.length}</span>
					</h2>
					<div className="bg-slate-brand border border-slate-brand rounded-lg divide-y divide-slate-brand">
						{resource.children.map((child) => (
							<Link
								key={child.urn}
								to={`${stackPath}/resources?urn=${encodeURIComponent(child.urn)}`}
								className="flex items-center justify-between px-4 py-3 hover:bg-slate-brand/50 transition-colors"
							>
								<div>
									<span className="text-sm text-mist font-medium">{child.name}</span>
									<span className="ml-2 font-mono text-xs text-cloud">{shortType(child.type)}</span>
								</div>
								<span className="text-cloud/60 text-sm">&rarr;</span>
							</Link>
						))}
					</div>
				</section>
			)}

			{/* ── Aliases ──────────────────────────────────────────────── */}
			{resource.aliases.length > 0 && (
				<section>
					<h2 className="text-lg font-semibold text-mist mb-3">
						Aliases
						<span className="text-xs text-cloud font-normal ml-2">{resource.aliases.length}</span>
					</h2>
					<div className="bg-slate-brand border border-slate-brand rounded-lg p-4 space-y-1.5">
						{resource.aliases.map((alias) => (
							<div key={alias} className="font-mono text-sm text-cloud break-all">
								{alias}
							</div>
						))}
					</div>
				</section>
			)}

			{/* ── Modified ─────────────────────────────────────────────── */}
			{resource.modified && (
				<div className="text-xs text-cloud/60 pt-4 border-t border-slate-brand">
					Last modified: {formatTimestamp(resource.modified)}
				</div>
			)}
		</div>
	);
}
