// Custom Lambda runtime for CLI API (buffered responses).
//
// Handles Pulumi CLI traffic (/api/*) with standard buffered responses.
// No streaming needed — CLI requests are short-lived request/response pairs.
//
// Uses the Lambda Runtime API directly (provided.al2023 custom runtime)
// with a simple JSON response format (no streaming framing).

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { INTERNAL_CLIENT_IP_HEADER } from "./middleware/security.js";

// biome-ignore lint/style/noNonNullAssertion: Lambda Runtime API always sets this
const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

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
	if (requestContext.http.sourceIp) {
		reqHeaders.set(INTERNAL_CLIENT_IP_HEADER, requestContext.http.sourceIp);
	}

	let reqBody: BodyInit | null = null;
	if (body && method !== "GET" && method !== "HEAD") {
		reqBody = isBase64Encoded ? Buffer.from(body, "base64") : body;
	}

	return new Request(url, { method, headers: reqHeaders, body: reqBody });
}

/** Post a buffered response back to the Lambda Runtime API. */
async function postResponse(requestId: string, response: Response): Promise<void> {
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	const body = await response.arrayBuffer();

	await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
		method: "POST",
		headers: { "Content-Type": "application/vnd.awslambda.http-integration-response" },
		body: JSON.stringify({
			statusCode: response.status,
			headers: responseHeaders,
			cookies: [] as string[],
			body: Buffer.from(body).toString("base64"),
			isBase64Encoded: true,
		}),
	});
}

(async () => {
	const { bootstrapCli } = await import("./bootstrap.js");
	const { app } = await bootstrapCli();
	while (true) {
		const next = await fetch(`${BASE_URL}/invocation/next`);
		// biome-ignore lint/style/noNonNullAssertion: Lambda Runtime API always sets this
		const requestId = next.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		const event = (await next.json()) as APIGatewayProxyEventV2;

		try {
			const request = eventToRequest(event);
			const response = await app.fetch(request);
			await postResponse(requestId, response);
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
