import { appendFile } from "node:fs/promises";

const JAEGER_API = process.env.JAEGER_API ?? "http://localhost:16686";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "procella-ci-bench";
const STEP_SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY;
const FLUSH_WAIT_MS = 3_000;

interface JaegerTag {
	key: string;
	type: string;
	value: string | number | boolean;
}

interface JaegerSpan {
	traceID: string;
	spanID: string;
	operationName: string;
	duration: number;
	tags: JaegerTag[];
}

interface JaegerTrace {
	traceID: string;
	spans: JaegerSpan[];
}

interface JaegerResponse {
	data: JaegerTrace[];
	errors: unknown[] | null;
}

interface SpanStats {
	count: number;
	p50: number;
	p95: number;
	max: number;
	total: number;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

function computeStats(durationsMs: number[]): SpanStats {
	const sorted = [...durationsMs].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
		total: sorted.reduce((s, v) => s + v, 0),
	};
}

async function fetchTraces(): Promise<JaegerTrace[]> {
	const url = `${JAEGER_API}/api/traces?service=${encodeURIComponent(SERVICE_NAME)}&limit=1000&lookback=1h`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Jaeger API ${res.status}: ${await res.text()}`);
	}
	const body = (await res.json()) as JaegerResponse;
	return body.data ?? [];
}

function padLeft(s: string, w: number): string {
	return s.length >= w ? s : `${" ".repeat(w - s.length)}${s}`;
}

function fmtMs(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

async function main(): Promise<void> {
	await Bun.sleep(FLUSH_WAIT_MS);

	const servicesRes = await fetch(`${JAEGER_API}/api/services`).catch(() => null);
	if (servicesRes?.ok) {
		const servicesBody = (await servicesRes.json()) as { data?: string[] };
		const services = servicesBody.data ?? [];
		console.log(`Jaeger services: ${services.length > 0 ? services.join(", ") : "(none)"}`);
	} else {
		console.log(`Jaeger API unreachable at ${JAEGER_API}/api/services`);
	}

	let traces: JaegerTrace[];
	try {
		traces = await fetchTraces();
	} catch (err) {
		console.log(`Trace analysis skipped: ${err instanceof Error ? err.message : err}`);
		return;
	}

	console.log(`Fetched ${traces.length} traces for service "${SERVICE_NAME}"`);
	if (traces.length === 0) {
		console.log("No traces found — trace analysis skipped.");
		return;
	}

	const allSpans = traces.flatMap((t) => t.spans);
	const groups = new Map<string, number[]>();
	for (const span of allSpans) {
		const name = span.operationName;
		let bucket = groups.get(name);
		if (!bucket) {
			bucket = [];
			groups.set(name, bucket);
		}
		bucket.push(span.duration / 1000);
	}

	const stats = [...groups.entries()]
		.map(([name, durations]) => ({ name, ...computeStats(durations) }))
		.sort((a, b) => b.total - a.total);

	const W_NAME = 40;
	const W_NUM = 8;

	const lines: string[] = [];
	lines.push("");
	lines.push("━".repeat(78));
	lines.push("  TRACE BREAKDOWN");
	lines.push("━".repeat(78));
	lines.push("");
	lines.push(
		`  ${"Operation".padEnd(W_NAME)}  ${padLeft("Count", W_NUM)}  ${padLeft("p50", W_NUM)}  ${padLeft("p95", W_NUM)}  ${padLeft("Max", W_NUM)}`,
	);
	lines.push(`  ${"─".repeat(W_NAME)}  ${"─".repeat(W_NUM)}  ${"─".repeat(W_NUM)}  ${"─".repeat(W_NUM)}  ${"─".repeat(W_NUM)}`);

	for (const s of stats) {
		lines.push(
			`  ${s.name.padEnd(W_NAME)}  ${padLeft(String(s.count), W_NUM)}  ${padLeft(fmtMs(s.p50), W_NUM)}  ${padLeft(fmtMs(s.p95), W_NUM)}  ${padLeft(fmtMs(s.max), W_NUM)}`,
		);
	}

	lines.push("");
	lines.push(`  ${allSpans.length} spans across ${traces.length} traces`);
	lines.push("━".repeat(78));

	const output = lines.join("\n");
	console.log(output);

	if (STEP_SUMMARY_PATH) {
		const md: string[] = [];
		md.push("### 🔍 Trace Breakdown\n");
		md.push("| Operation | Count | p50 | p95 | Max |");
		md.push("|:----------|------:|----:|----:|----:|");
		for (const s of stats) {
			md.push(`| \`${s.name}\` | ${s.count} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.max)} |`);
		}
		md.push(`\n> ${allSpans.length} spans across ${traces.length} traces\n`);
		await appendFile(STEP_SUMMARY_PATH, md.join("\n"));
	}
}

main().catch((err) => {
	console.error("Trace analysis failed:", err instanceof Error ? err.message : err);
});
