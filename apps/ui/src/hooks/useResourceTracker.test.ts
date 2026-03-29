import { describe, expect, test } from "bun:test";

type ResourceStatus = "pending" | "active" | "succeeded" | "failed" | "skipped";

interface TrackedResource {
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

function processEvents(events: unknown[]) {
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

	const resources = Array.from(state.values());
	const grouped = new Map<string, TrackedResource[]>();
	for (const resource of resources) {
		const group = grouped.get(resource.typeGroup) ?? [];
		group.push(resource);
		grouped.set(resource.typeGroup, group);
	}

	const completed = resources.filter(
		(resource) =>
			resource.status === "succeeded" ||
			resource.status === "skipped" ||
			resource.status === "failed",
	).length;
	const total = resources.length;

	return { resources, grouped, completed, total, map: state };
}

describe("useResourceTracker processing logic", () => {
	test("empty events returns empty map and zero counters", () => {
		const result = processEvents([]);
		expect(result.map.size).toBe(0);
		expect(result.total).toBe(0);
		expect(result.completed).toBe(0);
	});

	test("resourcePreEvent creates active resource", () => {
		const events = [
			{
				timestamp: 1710000000,
				resourcePreEvent: {
					metadata: {
						urn: "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::assets",
						type: "aws:s3/bucket:Bucket",
						op: "create",
					},
				},
			},
		];
		const result = processEvents(events);
		const res = result.map.get("urn:pulumi:dev::proj::aws:s3/bucket:Bucket::assets");
		expect(res?.status).toBe("active");
		expect(res?.name).toBe("assets");
		expect(res?.startedAt).toBe(1710000000 * 1000);
	});

	test("pre + outputs marks succeeded", () => {
		const urn = "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::assets";
		const result = processEvents([
			{
				timestamp: 1000,
				resourcePreEvent: { metadata: { urn, type: "aws:s3/bucket:Bucket", op: "create" } },
			},
			{ timestamp: 2000, resOutputsEvent: { metadata: { urn } } },
		]);
		expect(result.map.get(urn)?.status).toBe("succeeded");
		expect(result.map.get(urn)?.completedAt).toBe(2000 * 1000);
	});

	test("op same + outputs marks skipped", () => {
		const urn = "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::same";
		const result = processEvents([
			{
				timestamp: 10,
				resourcePreEvent: { metadata: { urn, type: "aws:s3/bucket:Bucket", op: "same" } },
			},
			{ timestamp: 20, resOutputsEvent: { metadata: { urn } } },
		]);
		expect(result.map.get(urn)?.status).toBe("skipped");
	});

	test("diagnostic error marks failed with message", () => {
		const urn = "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::bad";
		const result = processEvents([
			{
				timestamp: 10,
				resourcePreEvent: { metadata: { urn, type: "aws:s3/bucket:Bucket", op: "create" } },
			},
			{ timestamp: 30, diagnosticEvent: { urn, severity: "error", message: "boom" } },
		]);
		expect(result.map.get(urn)?.status).toBe("failed");
		expect(result.map.get(urn)?.errorMessage).toBe("boom");
	});

	test("multiple resources are grouped by typeGroup", () => {
		const result = processEvents([
			{
				timestamp: 1,
				resourcePreEvent: {
					metadata: { urn: "urn::a", type: "aws:s3/bucket:Bucket", op: "create" },
				},
			},
			{
				timestamp: 2,
				resourcePreEvent: {
					metadata: { urn: "urn::b", type: "aws:s3/bucket:Bucket", op: "create" },
				},
			},
			{
				timestamp: 3,
				resourcePreEvent: {
					metadata: { urn: "urn::c", type: "aws:ec2/instance:Instance", op: "create" },
				},
			},
		]);
		expect(result.grouped.get("aws:s3/bucket:Bucket")?.length).toBe(2);
		expect(result.grouped.get("aws:ec2/instance:Instance")?.length).toBe(1);
	});

	test("completed and total counts are correct", () => {
		const result = processEvents([
			{ timestamp: 1, resourcePreEvent: { metadata: { urn: "urn::1", type: "t", op: "create" } } },
			{ timestamp: 2, resOutputsEvent: { metadata: { urn: "urn::1" } } },
			{ timestamp: 3, resourcePreEvent: { metadata: { urn: "urn::2", type: "t", op: "same" } } },
			{ timestamp: 4, resOutputsEvent: { metadata: { urn: "urn::2" } } },
			{ timestamp: 5, resourcePreEvent: { metadata: { urn: "urn::3", type: "t", op: "create" } } },
			{ timestamp: 6, diagnosticEvent: { urn: "urn::3", severity: "error", message: "x" } },
			{ timestamp: 7, resourcePreEvent: { metadata: { urn: "urn::4", type: "t", op: "create" } } },
		]);
		expect(result.total).toBe(4);
		expect(result.completed).toBe(3);
	});

	test("timestamp normalization handles unix seconds and unix milliseconds", () => {
		const result = processEvents([
			{
				timestamp: 1710000000,
				resourcePreEvent: { metadata: { urn: "urn::sec", type: "t", op: "create" } },
			},
			{
				timestamp: 1710000000123,
				resourcePreEvent: { metadata: { urn: "urn::ms", type: "t", op: "create" } },
			},
		]);
		expect(result.map.get("urn::sec")?.startedAt).toBe(1710000000 * 1000);
		expect(result.map.get("urn::ms")?.startedAt).toBe(1710000000123);
	});
});
