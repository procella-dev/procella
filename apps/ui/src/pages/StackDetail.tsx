import * as Tabs from "@radix-ui/react-tabs";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Dialog, UpdateCard, type UpdateStatus } from "../components/ui";
import { trpc } from "../trpc";

// ============================================================================
// Helpers
// ============================================================================

function getResultColor(result: string) {
	switch (result) {
		case "succeeded":
			return "bg-green-900/30 text-green-400 border-green-900/50";
		case "failed":
			return "bg-red-900/30 text-red-300 border-red-900/50";
		case "in-progress":
			return "bg-yellow-900/30 text-yellow-400 border-yellow-900/50";
		case "cancelled":
			return "bg-slate-brand text-cloud border-cloud/30";
		default:
			return "bg-slate-brand text-cloud border-cloud/30";
	}
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

function toUpdateStatus(result: string): UpdateStatus {
	switch (result) {
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "in-progress":
			return "updating";
		default:
			return "queued";
	}
}

function toIsoOrNull(timestamp?: number | null): string | null {
	if (!timestamp) return null;
	return new Date(timestamp * 1000).toISOString();
}

function toChangeSummary(resourceChanges: Record<string, number>) {
	return {
		creates: resourceChanges.create ?? 0,
		updates: resourceChanges.update ?? 0,
		deletes: resourceChanges.delete ?? 0,
	};
}

/** Truncate a string in the middle for display. */
function truncateMiddle(str: string, maxLen: number) {
	if (str.length <= maxLen) return str;
	const half = Math.floor((maxLen - 3) / 2);
	return `${str.slice(0, half)}…${str.slice(-half)}`;
}

/** Shorten a resource type for display (e.g., "aws:s3/bucket:Bucket" → "s3/bucket:Bucket"). */
function shortType(type: string) {
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}

// ============================================================================
// Tab content components
// ============================================================================

interface UpdatesTabProps {
	org: string;
	project: string;
	stack: string;
	updates: Array<{
		updateID: string;
		kind: string;
		result: string;
		resourceChanges: Record<string, number>;
		startTime: number;
		endTime: number;
	}>;
}

function UpdatesTab({ org, project, stack, updates }: UpdatesTabProps) {
	if (updates.length === 0) {
		return (
			<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
				<p className="text-cloud">
					No updates yet. Run{" "}
					<code className="bg-slate-brand px-1.5 py-0.5 rounded text-sm">pulumi up</code> to create
					one.
				</p>
			</div>
		);
	}

	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-lg overflow-hidden">
			{updates.map((update) => (
				<UpdateCard
					key={update.updateID}
					updateId={update.updateID}
					href={`/stacks/${org}/${project}/${stack}/updates/${update.updateID}`}
					kind={update.kind}
					status={toUpdateStatus(update.result)}
					resourceChanges={toChangeSummary(update.resourceChanges)}
					startedAt={toIsoOrNull(update.startTime)}
					completedAt={toIsoOrNull(update.endTime)}
					isFirst={updates[0]?.updateID === update.updateID}
					isLast={updates[updates.length - 1]?.updateID === update.updateID}
				/>
			))}
		</div>
	);
}

interface ResourcesTabProps {
	org: string;
	project: string;
	stack: string;
	resources: Array<{
		urn: string;
		type: string;
		name: string;
		parent?: string;
		provider: string;
		id?: string;
		protect?: boolean;
		external?: boolean;
	}>;
	isLoading: boolean;
}

function ResourcesTab({ org, project, stack, resources, isLoading }: ResourcesTabProps) {
	if (isLoading) {
		return (
			<div className="bg-slate-brand border border-slate-brand rounded-lg overflow-hidden">
				<div className="animate-pulse space-y-0">
					{[1, 2, 3, 4].map((i) => (
						<div key={i} className="h-12 border-b border-slate-brand last:border-0" />
					))}
				</div>
			</div>
		);
	}

	if (resources.length === 0) {
		return (
			<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
				<p className="text-cloud">
					No resources.{" "}
					<code className="bg-slate-brand px-1.5 py-0.5 rounded text-sm">pulumi up</code> to deploy.
				</p>
			</div>
		);
	}

	return (
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
					{resources.map((r) => (
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
								{r.parent && <span className="ml-2 text-xs text-cloud/60">&larr; {r.parent}</span>}
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
									{!r.protect && !r.external && <span className="text-xs text-cloud/60">-</span>}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const SYSTEM_TAG_PREFIX = "pulumi:";

const btnBase =
	"inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60";
const btnSecondary = `${btnBase} border border-cloud/40 bg-slate-brand text-mist hover:border-cloud/60`;
const btnDanger = `${btnBase} border border-red-900/50 bg-red-900/20 text-red-300 hover:bg-red-900/30`;
const inputStyle =
	"rounded-md border border-cloud/30 bg-deep-sky px-3 py-2 text-sm text-mist placeholder:text-cloud/50 outline-none focus:border-lightning/50";

interface SettingsTabProps {
	org: string;
	project: string;
	stack: string;
	tags: Record<string, string>;
}

function SettingsTab({ org, project, stack, tags }: SettingsTabProps) {
	const navigate = useNavigate();
	const utils = trpc.useUtils();

	const [newTagKey, setNewTagKey] = useState("");
	const [newTagValue, setNewTagValue] = useState("");
	const [newName, setNewName] = useState("");
	const [exporting, setExporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [importSuccess, setImportSuccess] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [deleteConfirm, setDeleteConfirm] = useState("");
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [repairDialogOpen, setRepairDialogOpen] = useState(false);
	const [repairResult, setRepairResult] = useState<{
		mutations: Array<{ type: string; urn: string; detail?: string }>;
		mutationCount: number;
	} | null>(null);

	const updateTags = trpc.stacks.updateTags.useMutation({
		onSuccess: () => utils.stacks.detail.invalidate({ org, project, stack }),
	});

	const renameMut = trpc.stacks.rename.useMutation({
		onSuccess: () => navigate(`/stacks/${org}/${project}/${newName}`),
	});

	const deleteMut = trpc.stacks.delete.useMutation({
		onSuccess: () => navigate("/"),
	});

	const importMut = trpc.stacks.import.useMutation({
		onSuccess: () => {
			setImportSuccess(true);
			setImportError(null);
			utils.stacks.detail.invalidate({ org, project, stack });
			utils.stacks.resources.invalidate({ org, project, stack });
		},
		onError: (err) => setImportError(err.message),
	});

	const repairMut = trpc.stacks.repair.useMutation({
		onSuccess: (data) => {
			setRepairResult(data);
			setRepairDialogOpen(false);
		},
	});

	const userTags = Object.entries(tags).filter(([k]) => !k.startsWith(SYSTEM_TAG_PREFIX));
	const systemTags = Object.entries(tags).filter(([k]) => k.startsWith(SYSTEM_TAG_PREFIX));

	const handleAddTag = () => {
		const key = newTagKey.trim();
		const value = newTagValue.trim();
		if (!key || key.startsWith(SYSTEM_TAG_PREFIX)) return;
		updateTags.mutate({ org, project, stack, tags: { ...tags, [key]: value } });
		setNewTagKey("");
		setNewTagValue("");
	};

	const handleRemoveTag = (key: string) => {
		const updated = { ...tags };
		delete updated[key];
		updateTags.mutate({ org, project, stack, tags: updated });
	};

	const handleExport = async () => {
		setExporting(true);
		try {
			const data = await utils.stacks.export.fetch({ org, project, stack });
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${org}-${project}-${stack}.checkpoint.json`;
			a.click();
			URL.revokeObjectURL(url);
		} finally {
			setExporting(false);
		}
	};

	const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		setImportError(null);
		setImportSuccess(false);
		const reader = new FileReader();
		reader.onload = (ev) => {
			try {
				const deployment = JSON.parse(ev.target?.result as string);
				if (!deployment || typeof deployment !== "object") {
					setImportError("File does not contain a valid JSON object");
					return;
				}
				importMut.mutate({ org, project, stack, deployment });
			} catch {
				setImportError("Invalid JSON file");
			}
		};
		reader.readAsText(file);
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	return (
		<div className="space-y-8">
			{/* ── Tags ─────────────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-mist">Tags</h3>
					<p className="text-sm text-cloud mt-1">Custom metadata for this stack.</p>
				</div>
				<div className="bg-slate-brand/50 border border-slate-brand rounded-lg p-4 space-y-4">
					{userTags.length > 0 && (
						<div className="space-y-2">
							{userTags.map(([k, v]) => (
								<div key={k} className="flex items-center gap-2">
									<code className="text-sm text-mist font-mono">{k}</code>
									<span className="text-cloud/40">=</span>
									<span className="text-sm text-cloud">{v}</span>
									<button
										type="button"
										onClick={() => handleRemoveTag(k)}
										disabled={updateTags.isPending}
										className="ml-auto text-cloud/50 hover:text-red-300 transition-colors text-xs"
										aria-label={`Remove tag ${k}`}
									>
										&times;
									</button>
								</div>
							))}
						</div>
					)}

					<div className="flex items-center gap-2">
						<input
							type="text"
							placeholder="key"
							value={newTagKey}
							onChange={(e) => setNewTagKey(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
							className={`${inputStyle} w-32`}
						/>
						<input
							type="text"
							placeholder="value"
							value={newTagValue}
							onChange={(e) => setNewTagValue(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
							className={`${inputStyle} flex-1`}
						/>
						<button
							type="button"
							onClick={handleAddTag}
							disabled={!newTagKey.trim() || updateTags.isPending}
							className={btnSecondary}
						>
							Add
						</button>
					</div>

					{systemTags.length > 0 && (
						<div className="pt-2 border-t border-cloud/10">
							<div className="text-xs text-cloud/40 mb-1.5">System tags (read-only)</div>
							<div className="flex flex-wrap gap-2">
								{systemTags.map(([k, v]) => (
									<span
										key={k}
										className="px-2 py-0.5 bg-slate-brand rounded text-xs text-cloud/50 border border-cloud/10 font-mono"
									>
										{k}={v}
									</span>
								))}
							</div>
						</div>
					)}
				</div>
			</section>

			{/* ── Rename ───────────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-mist">Rename Stack</h3>
					<p className="text-sm text-cloud mt-1">
						Change this stack&apos;s name within the <code className="text-mist/70">{project}</code>{" "}
						project.
					</p>
				</div>
				<div className="bg-slate-brand/50 border border-slate-brand rounded-lg p-4">
					<div className="flex items-center gap-2">
						<input
							type="text"
							placeholder="new-stack-name"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) =>
								e.key === "Enter" &&
								newName.trim() &&
								renameMut.mutate({ org, project, stack, newStack: newName.trim() })
							}
							className={`${inputStyle} flex-1`}
						/>
						<button
							type="button"
							onClick={() => renameMut.mutate({ org, project, stack, newStack: newName.trim() })}
							disabled={!newName.trim() || newName.trim() === stack || renameMut.isPending}
							className={btnSecondary}
						>
							{renameMut.isPending ? "Renaming…" : "Rename"}
						</button>
					</div>
					{renameMut.error && (
						<p className="mt-2 text-sm text-red-300">{renameMut.error.message}</p>
					)}
				</div>
			</section>

			{/* ── Export ────────────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-mist">Export State</h3>
					<p className="text-sm text-cloud mt-1">Download the full Pulumi checkpoint as JSON.</p>
				</div>
				<div className="bg-slate-brand/50 border border-slate-brand rounded-lg p-4">
					<button
						type="button"
						onClick={handleExport}
						disabled={exporting}
						className={btnSecondary}
					>
						{exporting ? "Downloading…" : "Download Checkpoint"}
					</button>
				</div>
			</section>

			{/* ── Import ───────────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-mist">Import State</h3>
					<p className="text-sm text-cloud mt-1">
						Replace the stack&apos;s checkpoint from a previously exported JSON file.
					</p>
				</div>
				<div className="bg-slate-brand/50 border border-slate-brand rounded-lg p-4 space-y-3">
					<input
						ref={fileInputRef}
						type="file"
						accept=".json"
						onChange={handleImport}
						className="hidden"
					/>
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						disabled={importMut.isPending}
						className={btnSecondary}
					>
						{importMut.isPending ? "Importing…" : "Upload Checkpoint"}
					</button>
					{importSuccess && (
						<div
							className="rounded-md border p-3 text-sm"
							style={{
								borderColor: "color-mix(in srgb, var(--color-status-success) 45%, transparent)",
								color: "var(--color-status-success)",
							}}
						>
							&check; State imported successfully
						</div>
					)}
					{importError && <p className="text-sm text-red-300">{importError}</p>}
				</div>
			</section>

			{/* ── Repair ───────────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-mist">State Repair</h3>
					<p className="text-sm text-cloud mt-1">
						Scan and fix dangling parent references and orphaned resources in the checkpoint.
					</p>
				</div>
				<div className="bg-slate-brand/50 border border-slate-brand rounded-lg p-4 space-y-3">
					{repairResult === null ? (
						<button
							type="button"
							onClick={() => setRepairDialogOpen(true)}
							className={btnSecondary}
						>
							Run Repair
						</button>
					) : repairResult.mutationCount === 0 ? (
						<div
							className="rounded-md border p-3 text-sm"
							style={{
								borderColor: "color-mix(in srgb, var(--color-status-success) 45%, transparent)",
								color: "var(--color-status-success)",
							}}
						>
							&check; No issues found — state is healthy
						</div>
					) : (
						<div className="space-y-3">
							<div
								className="rounded-md border p-3 text-sm"
								style={{
									borderColor: "color-mix(in srgb, var(--color-status-success) 45%, transparent)",
									color: "var(--color-status-success)",
								}}
							>
								&check; Repair complete — {repairResult.mutationCount} issue
								{repairResult.mutationCount !== 1 ? "s" : ""} fixed
							</div>
							<ul className="space-y-2">
								{repairResult.mutations.map((m) => (
									<li
										key={`${m.type}-${m.urn}-${m.detail ?? ""}`}
										className="rounded-md bg-slate-brand p-3"
									>
										<div className="text-sm text-mist font-medium">{m.type}</div>
										<code className="block mt-1 text-xs text-cloud break-all">{m.urn}</code>
									</li>
								))}
							</ul>
							<button type="button" onClick={() => setRepairResult(null)} className={btnSecondary}>
								Run Again
							</button>
						</div>
					)}
				</div>

				<Dialog
					open={repairDialogOpen}
					onOpenChange={setRepairDialogOpen}
					title="Repair Stack State"
				>
					<div className="space-y-3 text-sm text-cloud">
						<p>
							This will scan the checkpoint for dangling parent refs and orphaned resources, and
							remove them.
						</p>
						<p style={{ color: "var(--color-status-error)" }}>This cannot be undone.</p>
						<div className="flex justify-end gap-2 pt-2">
							<button
								type="button"
								onClick={() => setRepairDialogOpen(false)}
								className={btnSecondary}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => repairMut.mutate({ org, project, stack })}
								disabled={repairMut.isPending}
								className={`${btnBase} text-deep-night disabled:opacity-60`}
								style={{ backgroundColor: "var(--color-lightning)" }}
							>
								{repairMut.isPending ? "Repairing…" : "Run Repair"}
							</button>
						</div>
					</div>
				</Dialog>
			</section>

			{/* ── Danger Zone ──────────────────────────────────────── */}
			<section>
				<div className="mb-4">
					<h3 className="text-base font-semibold text-red-300">Danger Zone</h3>
				</div>
				<div className="rounded-lg border border-red-900/50 p-4 space-y-3">
					<p className="text-sm text-cloud">
						Permanently delete <strong className="text-mist">{stack}</strong> and all its update
						history. This action cannot be undone.
					</p>
					<button
						type="button"
						onClick={() => {
							setDeleteConfirm("");
							setDeleteDialogOpen(true);
						}}
						className={btnDanger}
					>
						Delete Stack
					</button>
				</div>

				<Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} title="Delete Stack">
					<div className="space-y-4 text-sm text-cloud">
						<p>
							Type <strong className="text-mist font-mono">{stack}</strong> to confirm deletion.
						</p>
						<input
							type="text"
							value={deleteConfirm}
							onChange={(e) => setDeleteConfirm(e.target.value)}
							placeholder={stack}
							className={`${inputStyle} w-full`}
							autoFocus
						/>
						<div className="flex justify-end gap-2 pt-1">
							<button
								type="button"
								onClick={() => setDeleteDialogOpen(false)}
								className={btnSecondary}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => deleteMut.mutate({ org, project, stack })}
								disabled={deleteConfirm !== stack || deleteMut.isPending}
								className={`${btnDanger} disabled:opacity-40`}
							>
								{deleteMut.isPending ? "Deleting…" : "Delete Permanently"}
							</button>
						</div>
						{deleteMut.error && <p className="text-sm text-red-300">{deleteMut.error.message}</p>}
					</div>
				</Dialog>
			</section>
		</div>
	);
}

// ============================================================================
// Shared tab trigger styles
// ============================================================================

const tabTrigger = [
	"px-4 py-2.5 text-sm font-medium transition-colors",
	"text-cloud hover:text-mist",
	"border-b-2 border-transparent",
	"data-[state=active]:text-lightning data-[state=active]:border-lightning",
	"outline-none focus-visible:ring-1 focus-visible:ring-lightning/50",
].join(" ");

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
	} = trpc.stacks.detail.useQuery(params, { enabled, refetchOnMount: true });
	const {
		data: resources,
		isLoading: resourcesLoading,
		error: resourcesError,
	} = trpc.stacks.resources.useQuery(params, { enabled, refetchOnMount: true });
	const {
		data: updates,
		isLoading: updatesLoading,
		error: updatesError,
	} = trpc.updates.list.useQuery(params, { enabled, refetchOnMount: true });

	// Real-time updates via SSE — new deployments and status changes appear instantly
	const utils = trpc.useUtils();
	trpc.updates.onStackActivity.useSubscription(params, {
		enabled,
		onData: () => {
			// Refresh all stack data when an update is created/started/completed
			utils.updates.list.invalidate();
			utils.stacks.detail.invalidate();
			utils.stacks.resources.invalidate();
		},
	});

	const isLoading = (detailLoading && !detail) || (updatesLoading && !updates);

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

	// ── Error State ───────────────────────────────────────────────────
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
				<div className="bg-red-900/20 border border-red-900/50 text-red-300 p-4 rounded-lg">
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
				<div className="bg-slate-brand border border-slate-brand rounded-lg p-5">
					<div className="text-xs font-medium text-cloud uppercase tracking-wider mb-2">
						Version
					</div>
					<div className="text-2xl font-bold text-mist">v{detail?.version ?? 0}</div>
				</div>

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

			{/* ── Tabs ─────────────────────────────────────────────────── */}
			<Tabs.Root defaultValue="updates">
				<Tabs.List className="flex border-b border-slate-brand gap-1 -mb-px">
					<Tabs.Trigger value="updates" className={tabTrigger}>
						Updates
						{updateItems.length > 0 && (
							<span className="ml-2 text-xs text-cloud bg-slate-brand px-1.5 py-0.5 rounded-full">
								{updateItems.length}
							</span>
						)}
					</Tabs.Trigger>
					<Tabs.Trigger value="resources" className={tabTrigger}>
						Resources
						{resourceItems.length > 0 && (
							<span className="ml-2 text-xs text-cloud bg-slate-brand px-1.5 py-0.5 rounded-full">
								{resourceItems.length}
							</span>
						)}
					</Tabs.Trigger>
					<Tabs.Trigger value="settings" className={tabTrigger}>
						Settings
					</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="updates" className="pt-6 outline-none">
					<UpdatesTab
						org={params.org}
						project={params.project}
						stack={params.stack}
						updates={updateItems}
					/>
				</Tabs.Content>

				<Tabs.Content value="resources" className="pt-6 outline-none">
					<ResourcesTab
						org={params.org}
						project={params.project}
						stack={params.stack}
						resources={resourceItems}
						isLoading={resourcesLoading}
					/>
				</Tabs.Content>

				<Tabs.Content value="settings" className="pt-6 outline-none">
					<SettingsTab
						org={params.org}
						project={params.project}
						stack={params.stack}
						tags={detail?.tags ?? {}}
					/>
				</Tabs.Content>
			</Tabs.Root>
		</div>
	);
}
