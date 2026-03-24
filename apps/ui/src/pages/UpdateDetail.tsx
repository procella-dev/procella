import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { trpc } from "../trpc";

interface EngineEvent {
	sequence: number;
	timestamp: number;
	summaryEvent?: { resourceChanges: Record<string, number> };
	diagnosticEvent?: { severity: string; message: string };
	resourcePreEvent?: { metadata: { type: string; urn: string; op: string } };
	resOutputsEvent?: { metadata: { type: string; urn: string; op: string } };
	cancelEvent?: Record<string, unknown>;
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
	const continuationTokenRef = useRef<string | undefined>(undefined);
	const eventsEndRef = useRef<HTMLDivElement>(null);

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
			enabled: Boolean(org && project && stack && updateID && isPolling),
			refetchInterval: isPolling ? 2000 : false,
		},
	);

	const error = queryError?.message ?? null;

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

	// Auto-scroll to bottom when new events arrive
	useEffect(() => {
		eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	const getResultColor = (result?: string) => {
		switch (result) {
			case "succeeded":
				return "bg-green-900/30 text-green-400 border-green-900/50";
			case "failed":
				return "bg-red-900/30 text-red-400 border-red-900/50";
			case "in-progress":
				return "bg-yellow-900/30 text-yellow-400 border-yellow-900/50";
			default:
				return "bg-slate-brand text-cloud border-cloud/30";
		}
	};

	const getKindColor = (kind?: string) => {
		switch (kind) {
			case "update":
				return "bg-lightning/10 text-lightning border-lightning/20";
			case "preview":
				return "bg-purple-900/30 text-purple-400 border-purple-900/50";
			case "destroy":
				return "bg-red-900/30 text-red-400 border-red-900/50";
			case "refresh":
				return "bg-teal-900/30 text-teal-400 border-teal-900/50";
			default:
				return "bg-slate-brand text-cloud border-cloud/30";
		}
	};

	const getOpColor = (op: string) => {
		switch (op) {
			case "create":
				return "text-green-400";
			case "update":
				return "text-yellow-400";
			case "delete":
				return "text-red-400";
			case "same":
				return "text-cloud";
			default:
				return "text-lightning";
		}
	};

	const renderEvent = (event: EngineEvent) => {
		const time = new Date(event.timestamp * 1000).toLocaleTimeString();

		if (event.diagnosticEvent) {
			const { severity, message } = event.diagnosticEvent;
			const colorClass =
				severity === "error"
					? "text-red-400"
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
					<span className="shrink-0 w-16 font-medium text-red-400">cancel</span>
					<span className="text-red-300 font-mono text-sm">Update cancelled</span>
				</div>
			);
		}

		return null;
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
		<div className="space-y-6 flex flex-col h-[calc(100vh-8rem)]">
			<div className="flex items-center justify-between shrink-0">
				<div className="flex items-center gap-4">
					<Link
						to={`/stacks/${org}/${project}/${stack}`}
						className="text-cloud hover:text-mist transition-colors"
					>
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-mist">
						Update <span className="text-cloud font-normal">v{updateID}</span>
					</h1>
				</div>

				{updateInfo && (
					<div className="flex items-center gap-3">
						<span
							className={`px-3 py-1 rounded-full text-sm font-medium border ${getKindColor(updateInfo.kind)}`}
						>
							{updateInfo.kind}
						</span>
						<span
							className={`px-3 py-1 rounded-full text-sm font-medium border ${getResultColor(updateInfo.result)}`}
						>
							{updateInfo.result}
						</span>
						{isPolling && (
							<span className="flex items-center gap-2 text-sm text-cloud">
								<span className="relative flex h-2.5 w-2.5">
									<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lightning opacity-75" />
									<span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-lightning" />
								</span>
								Live
							</span>
						)}
					</div>
				)}
			</div>

			{error && (
				<div className="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg shrink-0">
					{error}
				</div>
			)}

			<div className="flex-1 bg-deep-sky border border-slate-brand rounded-lg overflow-hidden flex flex-col shadow-xl">
				<div className="bg-slate-brand border-b border-slate-brand px-4 py-2 flex justify-between items-center shrink-0">
					<h3 className="text-sm font-medium text-mist/80">Event Log</h3>
					<div className="text-xs text-cloud font-mono">{events.length} events</div>
				</div>

				<div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
					{events.length === 0 ? (
						<div className="h-full flex items-center justify-center text-cloud">
							Waiting for events...
						</div>
					) : (
						<div className="space-y-1">
							{events.map(renderEvent)}
							<div ref={eventsEndRef} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
