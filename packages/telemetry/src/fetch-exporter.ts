// Bun-compatible OTLP trace exporter using native fetch instead of node:http.
// Workaround for https://github.com/open-telemetry/opentelemetry-js/issues/5260
// The official @opentelemetry/exporter-trace-otlp-http uses node:http.request +
// stream.Readable.pipe which breaks under Bun's compatibility layer.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

function resolveEndpoint(configUrl?: string): string {
	if (configUrl) return configUrl;
	const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	if (tracesEndpoint) return tracesEndpoint;
	const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
	return `${baseEndpoint.replace(/\/$/, "")}/v1/traces`;
}

function parseHeadersEnv(): Record<string, string> {
	const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
	if (!raw) return {};
	const headers: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const idx = pair.indexOf("=");
		if (idx > 0) {
			headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
		}
	}
	return headers;
}

export class FetchOtlpTraceExporter implements SpanExporter {
	private readonly url: string;
	private readonly headers: Record<string, string>;

	constructor(config?: { url?: string }) {
		this.url = resolveEndpoint(config?.url);
		this.headers = parseHeadersEnv();
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const bytes = JsonTraceSerializer.serializeRequest(spans);
		if (!bytes) {
			resultCallback({ code: ExportResultCode.FAILED });
			return;
		}

		const body = new TextDecoder().decode(bytes);
		fetch(this.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers,
			},
			body,
		})
			.then((res) => {
				resultCallback({
					code: res.ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
				});
			})
			.catch(() => {
				resultCallback({ code: ExportResultCode.FAILED });
			});
	}

	async shutdown(): Promise<void> {}

	async forceFlush(): Promise<void> {}
}
