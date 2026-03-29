// @procella/telemetry — OpenTelemetry SDK initialization.
//
// Initializes the OTLP trace exporter when PROCELLA_OTEL_ENABLED=true.
// All standard OTEL_* env vars are respected for endpoint, headers, etc.
// Call initTelemetry() before any other imports that need tracing.

import { DiagConsoleLogger, DiagLogLevel, diag, metrics } from "@opentelemetry/api";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { FetchOtlpTraceExporter } from "./fetch-exporter.js";
import { FetchOtlpMetricExporter } from "./metrics-exporter.js";

let traceProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;

export interface TelemetryConfig {
	enabled: boolean;
	serviceName?: string;
	serviceVersion?: string;
	/** Override OTLP endpoint (otherwise uses OTEL_EXPORTER_OTLP_ENDPOINT env var). */
	otlpEndpoint?: string;
	debug?: boolean;
}

/**
 * Initialize OpenTelemetry tracing. Call once at startup, before creating spans.
 * No-op if `enabled` is false — all span operations become transparent pass-through.
 */
export function initTelemetry(config: TelemetryConfig): void {
	if (!config.enabled) {
		return;
	}

	if (config.debug) {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
	}
	const serviceName = process.env.OTEL_SERVICE_NAME ?? config.serviceName ?? "procella";
	const envAttrs: Record<string, string> = {};
	for (const pair of (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",")) {
		const idx = pair.indexOf("=");
		if (idx > 0) {
			envAttrs[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
		}
	}
	const resource = defaultResource().merge(
		resourceFromAttributes({
			...envAttrs,
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.0",
		}),
	);

	const baseUrl = config.otlpEndpoint
		? config.otlpEndpoint.replace(/\/v1\/(traces|metrics)$/, "")
		: undefined;
	const traceExporter = new FetchOtlpTraceExporter(
		baseUrl ? { url: `${baseUrl}/v1/traces` } : undefined,
	);
	traceProvider = new NodeTracerProvider({
		resource,
		spanProcessors: [new BatchSpanProcessor(traceExporter)],
	});
	traceProvider.register();

	const metricExporter = new FetchOtlpMetricExporter(
		baseUrl ? { url: `${baseUrl}/v1/metrics` } : undefined,
	);
	const metricReader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 15_000,
	});
	meterProvider = new MeterProvider({ resource, readers: [metricReader] });
	metrics.setGlobalMeterProvider(meterProvider);
}

/**
 * Gracefully shut down the telemetry SDK. Flushes pending spans.
 * Call during server shutdown, before process.exit().
 */
export async function shutdownTelemetry(): Promise<void> {
	await Promise.all([traceProvider?.shutdown(), meterProvider?.shutdown()]);
	traceProvider = null;
	meterProvider = null;
}
