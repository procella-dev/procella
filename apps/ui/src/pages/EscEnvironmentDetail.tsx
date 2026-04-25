import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
import YAML from "yaml";
import { EscResolvedValues } from "../components/EscResolvedValues";
import { EscRevisionDiff } from "../components/EscRevisionDiff";
import { EscSessions, useSessionTracker } from "../components/EscSessions";
import { apiBase } from "../config";
import { useOrg } from "../hooks/useOrg";
import { getAuthHeaders, trpc } from "../trpc";

type Tab = "editor" | "values" | "sessions";

function formatDate(date: Date): string {
	return new Date(date).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function EscEnvironmentDetail() {
	const { project, envName } = useParams<{ project: string; envName: string }>();
	const { org } = useOrg();
	const [activeTab, setActiveTab] = useState<Tab>("editor");

	const {
		data: env,
		isLoading,
		error: queryError,
		refetch,
	} = trpc.esc.getEnvironment.useQuery(
		{ project: project ?? "", environment: envName ?? "" },
		{ enabled: !!project && !!envName },
	);

	const { data: revisions, refetch: refetchRevisions } = trpc.esc.listRevisions.useQuery(
		{ project: project ?? "", environment: envName ?? "" },
		{ enabled: !!project && !!envName },
	);

	const [yamlContent, setYamlContent] = useState("");
	const [yamlError, setYamlError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
	const [compareRevision, setCompareRevision] = useState<number | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const envId = env?.id ?? "";
	const { addSession } = useSessionTracker(envId);

	const { data: revisionData } = trpc.esc.getRevision.useQuery(
		{ project: project ?? "", environment: envName ?? "", revision: selectedRevision ?? 0 },
		{ enabled: !!project && !!envName && selectedRevision != null },
	);

	const { data: compareRevisionData } = trpc.esc.getRevision.useQuery(
		{ project: project ?? "", environment: envName ?? "", revision: compareRevision ?? 0 },
		{ enabled: !!project && !!envName && compareRevision != null },
	);

	useEffect(() => {
		if (env && !dirty && selectedRevision == null) {
			setYamlContent(env.yamlBody);
		}
	}, [env, dirty, selectedRevision]);

	useEffect(() => {
		if (revisionData && selectedRevision != null) {
			setYamlContent(revisionData.yamlBody);
			setYamlError(null);
		}
	}, [revisionData, selectedRevision]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value;
		setYamlContent(value);
		setDirty(true);
		setSelectedRevision(null);
		setSaveError(null);
		try {
			YAML.parse(value);
			setYamlError(null);
		} catch (err: unknown) {
			setYamlError(err instanceof Error ? err.message : "Invalid YAML");
		}
	}, []);

	const handleSave = useCallback(async () => {
		if (yamlError || !dirty || saving) return;
		setSaving(true);
		setSaveError(null);
		try {
			const authHeaders = getAuthHeaders();
			const res = await fetch(
				`${apiBase}/api/esc/v1-internal/environments/${encodeURIComponent(org)}/${encodeURIComponent(project ?? "")}/${encodeURIComponent(envName ?? "")}`,
				{
					method: "PATCH",
					headers: {
						...authHeaders,
						Accept: "application/vnd.pulumi+8",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ yamlBody: yamlContent }),
				},
			);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(text || `Save failed (${res.status})`);
			}
			setDirty(false);
			await Promise.all([refetch(), refetchRevisions()]);
		} catch (err: unknown) {
			setSaveError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}, [yamlContent, yamlError, dirty, saving, org, project, envName, refetch, refetchRevisions]);

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				handleSave();
			}
		}
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [handleSave]);

	useEffect(() => {
		if (!dirty) return;
		function handleBeforeUnload(e: BeforeUnloadEvent) {
			e.preventDefault();
		}
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [dirty]);

	const blocker = useBlocker(
		({ currentLocation, nextLocation }) =>
			dirty && currentLocation.pathname !== nextLocation.pathname,
	);

	useEffect(() => {
		if (blocker.state === "blocked") {
			const ok = window.confirm("You have unsaved changes. Leave this page?");
			if (ok) blocker.proceed();
			else blocker.reset();
		}
	}, [blocker]);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="h-6 w-48 bg-slate-brand rounded animate-pulse" />
				<div className="h-[400px] bg-slate-brand rounded-xl border border-slate-brand animate-pulse" />
			</div>
		);
	}

	if (queryError) {
		return (
			<div className="space-y-6">
				<Breadcrumb project={project} envName={envName} />
				<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-4 rounded-xl text-sm">
					{queryError.message}
				</div>
			</div>
		);
	}

	const isViewingRevision = selectedRevision != null;
	const canSave = dirty && !yamlError && !saving && !isViewingRevision;
	const showDiff = compareRevision != null && compareRevisionData;

	const tabs: { key: Tab; label: string }[] = [
		{ key: "editor", label: "Editor" },
		{ key: "values", label: "Resolved Values" },
		{ key: "sessions", label: "Sessions" },
	];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<Breadcrumb project={project} envName={envName} />
				<div className="flex items-center gap-3">
					{dirty && <span className="text-xs text-flash">Unsaved changes</span>}
					{env && (
						<span className="text-xs text-cloud font-mono">rev #{env.currentRevisionNumber}</span>
					)}
					{activeTab === "editor" && (
						<button
							type="button"
							onClick={handleSave}
							disabled={!canSave}
							className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
								canSave
									? "bg-lightning text-deep-sky hover:bg-lightning/90"
									: "bg-slate-brand text-cloud/50 cursor-not-allowed"
							}`}
						>
							{saving ? "Saving\u2026" : "Save"}
						</button>
					)}
				</div>
			</div>

			<div className="flex gap-1 border-b border-slate-brand">
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => setActiveTab(tab.key)}
						className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
							activeTab === tab.key
								? "text-lightning border-lightning"
								: "text-cloud hover:text-mist border-transparent"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			{saveError && (
				<div className="bg-red-950/30 border border-red-900/40 text-red-300 p-3 rounded-xl text-sm">
					{saveError}
				</div>
			)}

			{activeTab === "editor" && (
				<>
					{showDiff && env && (
						<EscRevisionDiff
							leftYaml={compareRevisionData.yamlBody}
							rightYaml={env.yamlBody}
							leftLabel={`Revision #${compareRevision}`}
							rightLabel="Current"
							onClose={() => setCompareRevision(null)}
						/>
					)}

					<div className="flex gap-6">
						<div className="flex-1 min-w-0">
							{yamlError && (
								<div className="mb-2 text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2 font-mono">
									{yamlError}
								</div>
							)}
							<div className="relative">
								{isViewingRevision && (
									<div className="absolute top-0 left-0 right-0 bg-flash/10 border-b border-flash/20 px-3 py-1.5 text-xs text-flash z-10 rounded-t-xl flex items-center justify-between">
										<span>Viewing revision #{selectedRevision}</span>
										<button
											type="button"
											onClick={() => {
												setSelectedRevision(null);
												if (env) {
													setYamlContent(env.yamlBody);
													setDirty(false);
												}
											}}
											className="text-flash hover:text-white transition-colors"
										>
											Back to latest
										</button>
									</div>
								)}
								<textarea
									ref={textareaRef}
									value={yamlContent}
									onChange={handleChange}
									readOnly={isViewingRevision}
									spellCheck={false}
									className={`w-full h-[500px] bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 font-mono text-sm text-mist leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-lightning focus:border-transparent placeholder:text-zinc-500 ${
										isViewingRevision ? "pt-10 opacity-75" : ""
									}`}
									placeholder="# Enter your YAML configuration..."
								/>
							</div>
							<p className="mt-1.5 text-xs text-cloud/60">
								<kbd className="font-mono bg-slate-brand px-1 py-0.5 rounded text-cloud/80">
									{"\u2318S"}
								</kbd>{" "}
								or{" "}
								<kbd className="font-mono bg-slate-brand px-1 py-0.5 rounded text-cloud/80">
									Ctrl+S
								</kbd>{" "}
								to save
							</p>
						</div>

						<div className="w-64 shrink-0">
							<h3 className="text-sm font-medium text-mist mb-3">Revisions</h3>
							<div className="bg-slate-brand/50 border border-slate-brand rounded-xl overflow-hidden max-h-[520px] overflow-y-auto">
								{revisions && revisions.length > 0 ? (
									revisions.map((rev) => {
										const isSelected = selectedRevision === rev.revisionNumber;
										const isCurrent =
											env?.currentRevisionNumber === rev.revisionNumber && !isViewingRevision;
										return (
											<div
												key={rev.id}
												className={`w-full text-left px-3 py-2.5 border-b border-slate-brand/40 transition-colors ${
													isSelected
														? "bg-lightning/10 border-l-2 border-l-lightning"
														: "hover:bg-slate-brand/80"
												}`}
											>
												<button
													type="button"
													onClick={() => {
														if (isSelected) {
															setSelectedRevision(null);
															if (env) {
																setYamlContent(env.yamlBody);
																setDirty(false);
															}
														} else {
															if (dirty && !window.confirm("Discard unsaved changes?")) return;
															setSelectedRevision(rev.revisionNumber);
															setDirty(false);
														}
													}}
													className="w-full text-left"
												>
													<div className="flex items-center justify-between">
														<span className="text-sm font-mono text-mist">
															#{rev.revisionNumber}
														</span>
														{isCurrent && (
															<span className="text-[10px] font-medium text-lightning bg-lightning/10 px-1.5 py-0.5 rounded">
																latest
															</span>
														)}
													</div>
													<div className="text-xs text-cloud mt-0.5">{rev.createdBy}</div>
													<div className="text-xs text-cloud/60 mt-0.5">
														{formatDate(rev.createdAt)}
													</div>
												</button>
												{!isCurrent && (
													<button
														type="button"
														onClick={() =>
															setCompareRevision(
																compareRevision === rev.revisionNumber ? null : rev.revisionNumber,
															)
														}
														className={`mt-1 text-[10px] px-2 py-0.5 rounded transition-colors ${
															compareRevision === rev.revisionNumber
																? "bg-lightning/20 text-lightning"
																: "text-cloud/50 hover:text-cloud bg-slate-brand/60"
														}`}
													>
														{compareRevision === rev.revisionNumber ? "Hide diff" : "Compare"}
													</button>
												)}
											</div>
										);
									})
								) : (
									<div className="px-3 py-4 text-xs text-cloud/60 text-center">
										No revisions yet
									</div>
								)}
							</div>
						</div>
					</div>
				</>
			)}

			{activeTab === "values" && project && envName && (
				<EscResolvedValues project={project} environment={envName} onSessionOpened={addSession} />
			)}

			{activeTab === "sessions" && project && envName && envId && (
				<EscSessions project={project} environment={envName} envId={envId} />
			)}
		</div>
	);
}

function Breadcrumb({ project, envName }: { project?: string; envName?: string }) {
	return (
		<div className="flex items-center gap-2 text-sm">
			<Link to="/esc" className="text-cloud hover:text-mist transition-colors">
				Environments
			</Link>
			<span className="text-cloud/40">/</span>
			<span className="text-cloud">{project}</span>
			<span className="text-cloud/40">/</span>
			<span className="text-mist font-medium">{envName}</span>
		</div>
	);
}
