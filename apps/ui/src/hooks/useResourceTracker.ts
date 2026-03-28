import { useMemo } from "react";

export type ResourceStatus = "pending" | "active" | "succeeded" | "failed" | "skipped";

export interface TrackedResource {
	urn: string;
	name: string;
	type: string;
	typeGroup: string;
	op: string;
	status: ResourceStatus;
	startedAt?: number;
	completedAt?: number;
	errorMessage?: string;
}

interface ResourceAction {
	type: "pre" | "outputs" | "diagnostic";
	urn: string;
	resourceType?: string;
	op?: string;
	severity?: string;
	message?: string;
	timestamp: number;
}

function resourceReducer(
	state: Map<string, TrackedResource>,
	action: ResourceAction,
): Map<string, TrackedResource> {
	const next = new Map(state);
	const existing = next.get(action.urn);

	if (action.type === "pre") {
		const name = action.urn.split("::").pop() ?? action.urn;
		const typeGroup = action.resourceType ?? "unknown";
		next.set(action.urn, {
			urn: action.urn,
			name,
			type: typeGroup,
			typeGroup,
			op: action.op ?? "update",
			status: "active",
			startedAt: action.timestamp,
		});
	} else if (action.type === "outputs" && existing) {
		next.set(action.urn, {
			...existing,
			status: existing.op === "same" ? "skipped" : "succeeded",
			completedAt: action.timestamp,
		});
	} else if (action.type === "diagnostic" && action.severity === "error" && existing) {
		next.set(action.urn, {
			...existing,
			status: "failed",
			errorMessage: action.message,
			completedAt: action.timestamp,
		});
	}

	return next;
}

export function useResourceTracker(events: unknown[]) {
	const resourceMap = useMemo(() => {
		let state = new Map<string, TrackedResource>();

		for (const event of events) {
			const e = event as Record<string, unknown>;
			const tsRaw = e.timestamp;
			const timestamp =
				typeof tsRaw === "number"
					? tsRaw > 1_000_000_000_000
						? tsRaw
						: tsRaw * 1000
					: typeof tsRaw === "string"
						? Number.isNaN(new Date(tsRaw).getTime())
							? Date.now()
							: new Date(tsRaw).getTime()
						: Date.now();

			if (e.resourcePreEvent) {
				const pre = e.resourcePreEvent as {
					metadata?: { urn?: string; type?: string; op?: string };
				};
				if (pre.metadata?.urn) {
					state = resourceReducer(state, {
						type: "pre",
						urn: pre.metadata.urn,
						resourceType: pre.metadata.type,
						op: pre.metadata.op,
						timestamp,
					});
				}
			} else if (e.resOutputsEvent) {
				const out = e.resOutputsEvent as { metadata?: { urn?: string } };
				if (out.metadata?.urn) {
					state = resourceReducer(state, {
						type: "outputs",
						urn: out.metadata.urn,
						timestamp,
					});
				}
			} else if (e.diagnosticEvent) {
				const diag = e.diagnosticEvent as {
					urn?: string;
					severity?: string;
					message?: string;
				};
				if (diag.urn) {
					state = resourceReducer(state, {
						type: "diagnostic",
						urn: diag.urn,
						severity: diag.severity,
						message: diag.message,
						timestamp,
					});
				}
			}
		}

		return state;
	}, [events]);

	const resources = useMemo(() => Array.from(resourceMap.values()), [resourceMap]);

	const grouped = useMemo(() => {
		const groups = new Map<string, TrackedResource[]>();
		for (const resource of resources) {
			const group = groups.get(resource.typeGroup) ?? [];
			group.push(resource);
			groups.set(resource.typeGroup, group);
		}
		return groups;
	}, [resources]);

	const completed = resources.filter(
		(resource) =>
			resource.status === "succeeded" ||
			resource.status === "skipped" ||
			resource.status === "failed",
	).length;
	const total = resources.length;
	const hasErrors = resources.some((resource) => resource.status === "failed");

	return { resources, grouped, completed, total, hasErrors };
}
