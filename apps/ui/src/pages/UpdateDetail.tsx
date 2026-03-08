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
				return "bg-zinc-800 text-zinc-400 border-zinc-700";
		}
	};

	const getKindColor = (kind?: string) => {
		switch (kind) {
			case "update":
				return "bg-blue-900/30 text-blue-400 border-blue-900/50";
			case "preview":
				return "bg-purple-900/30 text-purple-400 border-purple-900/50";
			case "destroy":
				return "bg-red-900/30 text-red-400 border-red-900/50";
			case "refresh":
				return "bg-teal-900/30 text-teal-400 border-teal-900/50";
			default:
				return "bg-zinc-800 text-zinc-400 border-zinc-700";
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
				return "text-zinc-500";
			default:
				return "text-blue-400";
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
						: "text-blue-400";
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-1 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 px-2 -mx-2 rounded"
				>
					<span className="text-zinc-500 shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${colorClass}`}>[{severity}]</span>
					<span className="text-zinc-300 whitespace-pre-wrap font-mono text-sm">{message}</span>
				</div>
			);
		}

		if (event.resourcePreEvent) {
			const { op, type, urn } = event.resourcePreEvent.metadata;
			const name = urn.split("::").pop() ?? urn;
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-1 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 px-2 -mx-2 rounded"
				>
					<span className="text-zinc-500 shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${getOpColor(op)}`}>{op}</span>
					<span className="text-zinc-300 font-mono text-sm">
						<span className="text-zinc-500">{type}</span> {name}
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
					className="flex gap-4 py-1 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 px-2 -mx-2 rounded"
				>
					<span className="text-zinc-500 shrink-0 w-20">{time}</span>
					<span className={`shrink-0 w-16 font-medium ${getOpColor(op)}`}>{op} done</span>
					<span className="text-zinc-300 font-mono text-sm">
						<span className="text-zinc-500">{type}</span> {name}
					</span>
				</div>
			);
		}

		if (event.summaryEvent) {
			return (
				<div
					key={event.sequence}
					className="flex gap-4 py-3 border-b border-zinc-800/50 last:border-0 mt-4 bg-zinc-800/20 px-4 -mx-4 rounded-lg"
				>
					<span className="text-zinc-500 shrink-0 w-20">{time}</span>
					<span className="shrink-0 w-16 font-medium text-purple-400">summary</span>
					<div className="flex gap-4 text-sm">
						{Object.entries(event.summaryEvent.resourceChanges).map(([op, count]) => (
							<span key={op} className="text-zinc-300">
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
					className="flex gap-4 py-2 border-b border-zinc-800/50 last:border-0 bg-red-900/10 px-2 -mx-2 rounded"
				>
					<span className="text-zinc-500 shrink-0 w-20">{time}</span>
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
					<Link
						to={`/stacks/${org}/${project}/${stack}`}
						className="text-zinc-400 hover:text-zinc-200"
					>
						&larr; Back to Stack
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">Loading Update...</h1>
				</div>
				<div className="animate-pulse h-96 bg-zinc-900 rounded-lg border border-zinc-800" />
			</div>
		);
	}

	return (
		<div className="space-y-6 flex flex-col h-[calc(100vh-8rem)]">
			<div className="flex items-center justify-between shrink-0">
				<div className="flex items-center gap-4">
					<Link
						to={`/stacks/${org}/${project}/${stack}`}
						className="text-zinc-400 hover:text-zinc-200 transition-colors"
					>
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">
						Update <span className="text-zinc-500 font-normal">v{updateID}</span>
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
							<span className="flex items-center gap-2 text-sm text-zinc-400">
								<span className="relative flex h-2.5 w-2.5">
									<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
									<span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
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

			<div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden flex flex-col shadow-xl">
				<div className="bg-zinc-900 border-b border-zinc-800 px-4 py-2 flex justify-between items-center shrink-0">
					<h3 className="text-sm font-medium text-zinc-300">Event Log</h3>
					<div className="text-xs text-zinc-500 font-mono">{events.length} events</div>
				</div>

				<div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
					{events.length === 0 ? (
						<div className="h-full flex items-center justify-center text-zinc-500">
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
