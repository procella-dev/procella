// @procella/telemetry — OpenTelemetry SDK initialization.
//
// Initializes the OTLP trace exporter when PROCELLA_OTEL_ENABLED=true.
// All standard OTEL_* env vars are respected for endpoint, headers, etc.
// Call initTelemetry() before any other imports that need tracing.

import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { FetchOtlpTraceExporter } from "./fetch-exporter.js";

let provider: NodeTracerProvider | null = null;

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

	const defaults = new Resource({
		[ATTR_SERVICE_NAME]: config.serviceName ?? "procella",
		[ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.0",
	});
	// Resource.default() reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES env vars.
	// Merge so env vars override code defaults (merge gives precedence to argument).
	const resource = defaults.merge(Resource.default());

	provider = new NodeTracerProvider({ resource });

	const exporter = new FetchOtlpTraceExporter(
		config.otlpEndpoint ? { url: config.otlpEndpoint } : undefined,
	);
	provider.addSpanProcessor(new BatchSpanProcessor(exporter) as SpanProcessor);
	provider.register();
}

/**
 * Gracefully shut down the telemetry SDK. Flushes pending spans.
 * Call during server shutdown, before process.exit().
 */
export async function shutdownTelemetry(): Promise<void> {
	if (provider) {
		await provider.shutdown();
		provider = null;
	}
}
