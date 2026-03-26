// @procella/telemetry — OpenTelemetry instrumentation for Procella.
//
// Provides OTLP trace export, Hono middleware, and span utilities.
// All tracing is no-op when disabled — safe to leave wired in production.

export { FetchOtlpTraceExporter } from "./fetch-exporter.js";
export { activeContext, tracingMiddleware } from "./middleware.js";
export { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./sdk.js";
export { getTracer, withDbSpan, withSpan } from "./spans.js";
