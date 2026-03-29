import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { UpdateStatus } from "../components/ui/status";
import { StatusBadge } from "../components/ui/status";
import {
	type ResourceStatus,
	type TrackedResource,
	useResourceTracker,
} from "../hooks/useResourceTracker";
import { trpc } from "../trpc";

interface EngineEvent {
	sequence: number;
	timestamp: number;
	summaryEvent?: { resourceChanges: Record<string, number> };
	diagnosticEvent?: { severity: string; message: string; urn?: string };
	resourcePreEvent?: { metadata: { type: string; urn: string; op: string } };
	resOutputsEvent?: { metadata: { type: string; urn: string; op: string } };
	cancelEvent?: Record<string, unknown>;
}

type EventFilter = "all" | "errors" | "warnings";

function eventTimestampMs(event: EngineEvent): number {
	return event.timestamp > 1_000_000_000_000 ? event.timestamp : event.timestamp * 1000;
}

function formatDuration(ms?: number): string {
	if (ms == null || Number.isNaN(ms)) return "";
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const mins = Math.floor(seconds / 60);
	const rem = Math.floor(seconds % 60);
	return `${mins}m ${rem}s`;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const mins = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	return `${mins}m ${secs.toString().padStart(2, "0")}s elapsed`;
}

function formatRelative(ms: number, startMs: number): string {
	const diff = Math.max(0, Math.floor((ms - startMs) / 1000));
	const mins = Math.floor(diff / 60);
	const secs = diff % 60;
	return `+${mins}:${secs.toString().padStart(2, "0")}`;
}

function mapUpdateStatus(result?: string, hasEvents?: boolean): UpdateStatus {
	if (result === "succeeded") return "succeeded";
	if (result === "failed") return "failed";
	if (result === "cancelled") return "cancelled";
	if (result === "queued") return "queued";
	if (result === "not-started") return "not-started";
	if (result === "running") return "running";
	if (result === "updating" || result === "in-progress") return "updating";
	return hasEvents ? "updating" : "not-started";
}

function getResourceIcon(status: ResourceStatus): string {
	switch (status) {
		case "pending":
			return "○";
		case "active":
			return "◐";
		case "succeeded":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "—";
		default:
			return "○";
	}
}

function getResourceStatusClass(status: ResourceStatus): string {
	switch (status) {
		case "active":
			return "text-[var(--color-status-active)] animate-pulse";
		case "succeeded":
			return "text-[var(--color-status-success)]";
		case "failed":
			return "text-[var(--color-status-error)]";
		case "pending":
		case "skipped":
			return "text-cloud";
		default:
			return "text-cloud";
	}
}

function getOpBorder(op: string): string {
	switch (op) {
		case "create":
			return "border-l-green-500";
		case "update":
			return "border-l-yellow-500";
		case "delete":
			return "border-l-red-500";
		case "replace":
			return "border-l-purple-500";
		case "same":
			return "border-l-slate-brand opacity-70";
		default:
			return "border-l-lightning";
	}
}

export function UpdateDetail() {
	const { org, project, stack, updateID } = useParams<{
		org: string;
		project: string;
		stack: string;
		updateID: string;
	}>();

	const [events, setEvents] = useState<EngineEvent[]>([]);
	const [isPolling, setIsPolling] = useState(true);
	const [filter, setFilter] = useState<EventFilter>("all");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const continuationTokenRef = useRef<string | undefined>(undefined);
	const eventsEndRef = useRef<HTMLDivElement>(null);
	const logContainerRef = useRef<HTMLDivElement>(null);
	const utils = trpc.useUtils();

	const { data: updateInfo } = trpc.updates.latest.useQuery(
		{ org: org ?? "", project: project ?? "", stack: stack ?? "" },
		{ enabled: Boolean(org && project && stack) },
	);

	const { data: eventsData, error: queryError } = trpc.events.list.useQuery(
		{
			org: org ?? "",
			project: project ?? "",
			stack: stack ?? "",
			updateID: updateID ?? "",
			continuationToken: continuationTokenRef.current,
		},
		{
			enabled: Boolean(org && project && stack && updateID),
			refetchInterval: isPolling ? 2000 : false,
		},
	);

	const lastSeqRef = useRef<number>(0);

	trpc.updates.onEvents.useSubscription(
		{
			org: org ?? "",
			project: project ?? "",
			stack: stack ?? "",
			updateId: updateID ?? "",
			lastEventId: lastSeqRef.current || undefined,
		},
		{
			enabled: Boolean(org && project && stack && updateID),
			onData: (data) => {
				if (data.seq) lastSeqRef.current = data.seq;
				utils.events.list.invalidate();
				utils.updates.latest.invalidate();
			},
		},
	);

	const error = queryError?.message ?? null;
	const { grouped, completed, total } = useResourceTracker(events);

	const updateStatus = mapUpdateStatus(updateInfo?.result, events.length > 0);
	const isRunning = updateStatus === "running" || updateStatus === "updating";

	const firstEventTimestampMs = useMemo(
		() => (events.length > 0 ? eventTimestampMs(events[0]) : undefined),
		[events],
	);
	const updateStartTime = updateInfo?.startTime ?? 0;
	const updateEndTime = updateInfo?.endTime ?? 0;
	const startMs = updateStartTime > 0 ? updateStartTime * 1000 : firstEventTimestampMs;
	const endMs = updateEndTime > 0 ? updateEndTime * 1000 : nowMs;
	const elapsedMs = startMs ? Math.max(0, (isRunning ? nowMs : endMs) - startMs) : 0;
	const progressPct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

	const errorCount = useMemo(
		() => events.filter((event) => event.diagnosticEvent?.severity === "error").length,
		[events],
	);
	const warningCount = useMemo(
		() => events.filter((event) => event.diagnosticEvent?.severity === "warning").length,
		[events],
	);

	const filteredEvents = useMemo(() => {
		if (filter === "errors") {
			return events.filter((event) => event.diagnosticEvent?.severity === "error");
		}
		if (filter === "warnings") {
			return events.filter((event) => event.diagnosticEvent?.severity === "warning");
		}
		return events;
	}, [events, filter]);

	const sortedGroups = useMemo(() => {
		const entries = Array.from(grouped.entries());
		entries.sort(([typeA, resourcesA], [typeB, resourcesB]) => {
			const aHasError = resourcesA.some((resource) => resource.status === "failed");
			const bHasError = resourcesB.some((resource) => resource.status === "failed");
			if (aHasError !== bHasError) return aHasError ? -1 : 1;
			return typeA.localeCompare(typeB);
		});
		return entries;
	}, [grouped]);

	// Process incoming events
	useEffect(() => {
		if (!eventsData) return;

		if (eventsData.events.length > 0) {
			setEvents((prev) => {
				const existingSeqs = new Set(prev.map((e) => e.sequence));
				const newEvents = (eventsData.events as EngineEvent[]).filter(
					(e) => !existingSeqs.has(e.sequence),
				);
				return [...prev, ...newEvents].sort((a, b) => a.sequence - b.sequence);
			});
		}

		if (eventsData.continuationToken) {
			continuationTokenRef.current = eventsData.continuationToken;
		} else {
			setIsPolling(false);
		}
	}, [eventsData]);

	useEffect(() => {
		if (!isRunning) return;
		const id = setInterval(() => {
			setNowMs(Date.now());
		}, 1000);
		return () => clearInterval(id);
	}, [isRunning]);

	useEffect(() => {
		if (!updateInfo?.endTime) return;
		setNowMs(Date.now());
	}, [updateInfo?.endTime]);

	useEffect(() => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			for (const [groupType, resources] of sortedGroups) {
				const hasErrorGroup = resources.some((resource) => resource.status === "failed");
				const allDone = resources.every(
					(resource) =>
						resource.status === "succeeded" ||
						resource.status === "skipped" ||
						resource.status === "failed",
				);
				if (hasErrorGroup) next.delete(groupType);
				else if (allDone) next.add(groupType);
			}
			return next;
		});
	}, [sortedGroups]);

	// Auto-scroll to bottom when new events arrive
	useEffect(() => {
		if (filteredEvents.length === 0 || !isAtBottom) return;
		eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [filteredEvents, isAtBottom]);

	const getOpColor = (op: string) => {
		switch (op) {
			case "create":
				return "text-green-400";
			case "update":
				return "text-yellow-400";
			case "delete":
				return "text-red-300";
			case "same":
				return "text-cloud";
			default:
				return "text-lightning";
		}
	};

	const renderEvent = (event: EngineEvent) => {
		const time = formatRelative(eventTimestampMs(event), startMs ?? eventTimestampMs(event));

		if (event.diagnosticEvent) {
			const { severity, message } = event.diagnosticEvent;
			const colorClass =
				severity === "error"
					? "text-red-300"
					: severity === "warning"
						? "text-yellow-400"
						: "text-lightning";
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-1 border-b border-slate-brand/50 last:border-0 hover:bg-slate-brand/30 px-2 -mx-2 rounded"
				>
					<span className="text-cloud shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${colorClass}`}>[{severity}]</span>
					<span className="text-mist/80 whitespace-pre-wrap font-mono text-sm">{message}</span>
				</div>
			);
		}

		if (event.resourcePreEvent) {
			const { op, type, urn } = event.resourcePreEvent.metadata;
			const name = urn.split("::").pop() ?? urn;
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-1 border-b border-slate-brand/50 last:border-0 hover:bg-slate-brand/30 px-2 -mx-2 rounded"
				>
					<span className="text-cloud shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${getOpColor(op)}`}>{op}</span>
					<span className="text-mist/80 font-mono text-sm">
						<span className="text-cloud">{type}</span> {name}
					</span>
				</div>
			);
		}

		if (event.resOutputsEvent) {
			const { op, type, urn } = event.resOutputsEvent.metadata;
			const name = urn.split("::").pop() ?? urn;
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-1 border-b border-slate-brand/50 last:border-0 hover:bg-slate-brand/30 px-2 -mx-2 rounded"
				>
					<span className="text-cloud shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${getOpColor(op)}`}>{op} done</span>
					<span className="text-mist/80 font-mono text-sm">
						<span className="text-cloud">{type}</span> {name}
					</span>
				</div>
			);
		}

		if (event.summaryEvent) {
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-3 border-b border-slate-brand/50 last:border-0 mt-4 bg-slate-brand/20 px-4 -mx-4 rounded-lg"
				>
					<span className="text-cloud shrink-0 w-20">{time}</span>
					<span className="shrink-0 w-16 font-medium text-purple-400">summary</span>
					<div className="flex gap-4 text-sm">
						{Object.entries(event.summaryEvent.resourceChanges).map(([op, count]) => (
							<span key={op} className="text-mist/80">
								<span className={`font-bold ${getOpColor(op)}`}>{count}</span> {op}
							</span>
						))}
					</div>
				</div>
			);
		}

		if (event.cancelEvent) {
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-2 border-b border-slate-brand/50 last:border-0 bg-red-900/10 px-2 -mx-2 rounded"
				>
					<span className="text-cloud shrink-0 w-20">{time}</span>
					<span className="shrink-0 w-16 font-medium text-red-300">cancel</span>
					<span className="text-red-300 font-mono text-sm">Update cancelled</span>
				</div>
			);
		}

		return null;
	};

	const handleLogScroll = () => {
		const el = logContainerRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
		setIsAtBottom(nearBottom);
	};

	const toggleGroup = (groupType: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupType)) next.delete(groupType);
			else next.add(groupType);
			return next;
		});
	};

	const renderResourceRow = (resource: TrackedResource) => {
		const durationMs =
			resource.status === "active"
				? Math.max(0, nowMs - (resource.startedAt ?? nowMs))
				: resource.startedAt && resource.completedAt
					? Math.max(0, resource.completedAt - resource.startedAt)
					: undefined;

		return (
			<div
				key={resource.urn}
				className={`border-l-2 ${getOpBorder(resource.op)} rounded-r-md px-3 py-2 bg-slate-brand/20`}
			>
				<div className="flex items-center gap-2 text-sm">
					<span className={`w-4 text-center ${getResourceStatusClass(resource.status)}`}>
						{getResourceIcon(resource.status)}
					</span>
					<span className="text-mist font-mono">{resource.name}</span>
					<span className="text-cloud text-xs">{resource.status}</span>
					<span className="ml-auto text-cloud font-mono text-xs">
						{durationMs != null
							? resource.status === "active"
								? `(${formatDuration(durationMs)}...)`
								: formatDuration(durationMs)
							: ""}
					</span>
				</div>
				{resource.errorMessage && (
					<div className="mt-1 text-xs text-red-300 font-mono whitespace-pre-wrap">
						{resource.errorMessage}
					</div>
				)}
			</div>
		);
	};

	if (events.length === 0 && !eventsData) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to={`/stacks/${org}/${project}/${stack}`} className="text-cloud hover:text-mist">
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-mist">Loading Update...</h1>
				</div>
				<div className="animate-pulse h-96 bg-slate-brand rounded-lg border border-slate-brand" />
			</div>
		);
	}

	return (
		<div className="flex flex-col h-[calc(100vh-8rem)] gap-4">
			<header className="sticky top-0 z-10 bg-deep-sky/95 backdrop-blur border border-slate-brand rounded-lg px-4 py-3 shadow-xl shrink-0">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-3 min-w-0">
						<Link
							to={`/stacks/${org}/${project}/${stack}`}
							className="text-cloud hover:text-mist transition-colors shrink-0"
						>
							&larr; {project}/{stack}
						</Link>
						<code className="text-xs text-cloud font-mono">
							pulumi {updateInfo?.kind ?? "update"}
						</code>
					</div>
					<div className="flex items-center gap-3 shrink-0">
						<StatusBadge status={updateStatus} />
					</div>
				</div>

				<div className="mt-3 flex items-center gap-3">
					<div className="flex-1 h-2 bg-slate-brand rounded-full overflow-hidden relative">
						<div
							className="h-full bg-lightning transition-[width] duration-300 ease-out"
							style={{ width: `${progressPct}%` }}
						/>
						{total === 0 && <div className="absolute inset-0 bg-cloud/20 animate-pulse" />}
					</div>
					<span className="text-sm font-mono text-cloud shrink-0">
						{completed}/{total} resources
					</span>
					<span className="text-sm font-mono text-cloud shrink-0">{formatElapsed(elapsedMs)}</span>
				</div>
			</header>

			{error && (
				<div className="bg-red-900/20 border border-red-900/50 text-red-300 p-4 rounded-lg shrink-0">
					{error}
				</div>
			)}

			<div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-5 gap-4">
				<section className="lg:col-span-3 bg-deep-sky border border-slate-brand rounded-lg overflow-hidden flex flex-col shadow-xl min-h-0">
					<div className="bg-slate-brand border-b border-slate-brand px-4 py-2 flex justify-between items-center shrink-0">
						<h3 className="text-sm font-medium text-mist/80">Resource Tracker</h3>
						<div className="text-xs text-cloud font-mono">{total} resources</div>
					</div>
					<div className="flex-1 overflow-y-auto p-4 space-y-3">
						{sortedGroups.length === 0 ? (
							<div className="h-full flex items-center justify-center text-cloud">
								Waiting for resources...
							</div>
						) : (
							sortedGroups.map(([groupType, resources]) => {
								const collapsed = collapsedGroups.has(groupType);
								const failures = resources.filter(
									(resource) => resource.status === "failed",
								).length;
								return (
									<div
										key={groupType}
										className="border border-slate-brand rounded-lg overflow-hidden"
									>
										<button
											type="button"
											onClick={() => toggleGroup(groupType)}
											className="w-full px-3 py-2 bg-slate-brand/30 hover:bg-slate-brand/50 transition-colors flex items-center justify-between text-left"
										>
											<span className="text-mist font-mono text-sm">{groupType}</span>
											<span className="text-xs text-cloud">
												{resources.length} {failures > 0 ? `· ${failures} error` : ""}{" "}
												{collapsed ? "▸" : "▾"}
											</span>
										</button>
										{!collapsed && (
											<div className="p-2 space-y-2">{resources.map(renderResourceRow)}</div>
										)}
									</div>
								);
							})
						)}
					</div>
				</section>

				<section className="lg:col-span-2 bg-deep-sky border border-slate-brand rounded-lg overflow-hidden flex flex-col shadow-xl min-h-0">
					<div className="bg-slate-brand border-b border-slate-brand px-4 py-2 flex justify-between items-center shrink-0">
						<h3 className="text-sm font-medium text-mist/80">Event Log</h3>
						<div className="text-xs text-cloud font-mono">
							{filteredEvents.length}/{events.length}
						</div>
					</div>
					<div className="px-3 py-2 border-b border-slate-brand/60 flex gap-2 text-xs">
						<button
							type="button"
							onClick={() => setFilter("all")}
							className={`px-2 py-1 rounded ${filter === "all" ? "bg-lightning/20 text-lightning" : "text-cloud hover:text-mist"}`}
						>
							All
						</button>
						<button
							type="button"
							onClick={() => setFilter("errors")}
							className={`px-2 py-1 rounded ${filter === "errors" ? "bg-red-900/30 text-red-300" : "text-cloud hover:text-mist"}`}
						>
							Errors ({errorCount})
						</button>
						<button
							type="button"
							onClick={() => setFilter("warnings")}
							className={`px-2 py-1 rounded ${filter === "warnings" ? "bg-yellow-900/30 text-yellow-300" : "text-cloud hover:text-mist"}`}
						>
							Warnings ({warningCount})
						</button>
					</div>

					<div
						ref={logContainerRef}
						onScroll={handleLogScroll}
						className="flex-1 overflow-y-auto p-4 font-mono text-sm relative"
					>
						{filteredEvents.length === 0 ? (
							<div className="h-full flex items-center justify-center text-cloud">
								No events in this filter.
							</div>
						) : (
							<div className="space-y-1">
								{filteredEvents.map(renderEvent)}
								<div ref={eventsEndRef} />
							</div>
						)}

						{!isAtBottom && (
							<button
								type="button"
								onClick={() => {
									eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
									setIsAtBottom(true);
								}}
								className="absolute bottom-3 right-3 text-xs px-2 py-1 rounded bg-lightning/20 text-lightning border border-lightning/40"
							>
								Jump to bottom
							</button>
						)}
					</div>
				</section>
			</div>
		</div>
	);
}
