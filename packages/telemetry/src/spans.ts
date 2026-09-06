// @procella/telemetry — Span creation utilities for instrumenting application code.
//
// withSpan() wraps any async function in a child span.
// withDbSpan() adds standard database semantic attributes.
// These are no-ops when telemetry is disabled (the tracer returns NoopSpans).

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { projectError } from "@procella/types";
import { dbOperationCount, dbOperationDuration } from "./metrics.js";

/**
 * Wrap an async function in a named span. The span is automatically ended
 * on completion and records exceptions on failure.
 */
export async function withSpan<T>(
	tracerName: string,
	spanName: string,
	attrs: Record<string, string | number | boolean>,
	fn: () => Promise<T>,
): Promise<T> {
	const tracer = trace.getTracer(tracerName);
	return tracer.startActiveSpan(spanName, { attributes: attrs }, async (span) => {
		try {
			const result = await fn();
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (err) {
			const projected = projectError(err);
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: projected.message,
			});
			span.recordException(projected);
			throw err;
		} finally {
			span.end();
		}
	});
}

/**
 * Wrap an async function in a span with standard database semantic attributes.
 * Designed for instrumenting Drizzle ORM / raw SQL operations.
 */
export async function withDbSpan<T>(
	operation: string,
	attrs: Record<string, string | number | boolean>,
	fn: () => Promise<T>,
): Promise<T> {
	const startTime = performance.now();
	const metricAttrs = { "db.operation": operation };
	dbOperationCount().add(1, metricAttrs);
	try {
		return await withSpan(
			"procella.db",
			`db.${operation}`,
			{ "db.system": "postgresql", "db.operation": operation, ...attrs },
			fn,
		);
	} finally {
		dbOperationDuration().record(performance.now() - startTime, metricAttrs);
	}
}

export function getTracer(name: string) {
	return trace.getTracer(name);
}
