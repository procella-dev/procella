// Custom Lambda runtime with response streaming support for Web API.
//
// Handles tRPC dashboard traffic (/trpc/*) and auth routes (/api/auth/*)
// with streaming responses for SSE subscriptions.
//
// Uses the Lambda Runtime API streaming protocol:
//   Content-Type: application/vnd.awslambda.http-integration-response
//   Lambda-Runtime-Function-Response-Mode: streaming
//   Transfer-Encoding: chunked
//   Body: {JSON prelude}\x00\x00\x00\x00\x00\x00\x00\x00{response body}

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { sql } from "drizzle-orm";

// biome-ignore lint/style/noNonNullAssertion: Lambda Runtime API always sets this
const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

const NULL_DELIMITER = new Uint8Array(8);
const encoder = new TextEncoder();

/** Convert an APIGatewayProxyEventV2 into a standard Web Request. */
function eventToRequest(event: APIGatewayProxyEventV2): Request {
	const { requestContext, rawPath, rawQueryString, headers, body, isBase64Encoded } = event;
	const method = requestContext.http.method;

	const host =
		headers?.host ?? `${requestContext.apiId}.lambda-url.${process.env.AWS_REGION}.on.aws`;
	const qs = rawQueryString ? `?${rawQueryString}` : "";
	const url = `https://${host}${rawPath}${qs}`;

	const reqHeaders = new Headers();
	if (headers) {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) reqHeaders.set(key, value);
		}
	}
	if (event.cookies?.length) {
		reqHeaders.set("cookie", event.cookies.join("; "));
	}

	let reqBody: BodyInit | null = null;
	if (body && method !== "GET" && method !== "HEAD") {
		reqBody = isBase64Encoded ? Buffer.from(body, "base64") : body;
	}

	return new Request(url, { method, headers: reqHeaders, body: reqBody });
}

/** Stream a Response back to the Lambda Runtime API using the HTTP integration response format. */
async function streamResponse(requestId: string, response: Response): Promise<void> {
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	const prelude = JSON.stringify({
		statusCode: response.status,
		headers: responseHeaders,
		cookies: [] as string[],
	});

	const preludeBytes = encoder.encode(prelude);

	const responseBody = response.body;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(preludeBytes);
			controller.enqueue(NULL_DELIMITER);
			if (responseBody) {
				const reader = responseBody.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						controller.enqueue(value);
					}
				} finally {
					reader.releaseLock();
				}
			}
			controller.close();
		},
	});

	await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
		method: "POST",
		headers: {
			"Content-Type": "application/vnd.awslambda.http-integration-response",
			"Lambda-Runtime-Function-Response-Mode": "streaming",
			"Transfer-Encoding": "chunked",
		},
		body: stream,
		// @ts-expect-error — Bun supports duplex: "half" for streaming request bodies
		duplex: "half",
	});
}

(async () => {
	const { bootstrapWeb } = await import("./bootstrap.js");
	const { app, db } = await bootstrapWeb();

	// Pre-warm DB connection pool during Lambda init phase.
	try {
		await db.execute(sql`SELECT 1`);
	} catch {
		/* DB warmup is best-effort */
	}

	while (true) {
		const next = await fetch(`${BASE_URL}/invocation/next`);
		// biome-ignore lint/style/noNonNullAssertion: Lambda Runtime API always sets this
		const requestId = next.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		const event = (await next.json()) as APIGatewayProxyEventV2;

		try {
			const request = eventToRequest(event);
			const response = await app.fetch(request);
			await streamResponse(requestId, response);
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			await fetch(`${BASE_URL}/invocation/${requestId}/error`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					errorMessage: error.message,
					errorType: error.name,
					stackTrace: error.stack?.split("\n") ?? [],
				}),
			});
		}
	}
})();
