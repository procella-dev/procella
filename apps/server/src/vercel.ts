let appPromise: ReturnType<typeof init> | null = null;

async function init() {
	const { bootstrap } = await import("./bootstrap.js");
	const { app } = await bootstrap();
	return app;
}

/**
 * Vercel's Bun runtime may pass a non-standard Request-like object:
 *   - `headers` is a plain object (missing .get/.set/.has)
 *   - `url` is a relative path (e.g. "/api/auth/config")
 *
 * Reconstruct a spec-compliant Request so Hono's middleware works.
 * See: remix-i18next#117, oven-sh/bun#9846
 */
export function normalizeRequest(req: Request): Request {
	if (req.headers instanceof Headers) return req;

	const rawHeaders = req.headers as unknown as Record<string, string>;
	const headers = new Headers(rawHeaders);
	const host = rawHeaders.host || rawHeaders.Host || "localhost";
	const proto = rawHeaders["x-forwarded-proto"] || "https";
	const url = req.url.startsWith("http") ? req.url : `${proto}://${host}${req.url}`;

	return new Request(url, {
		method: req.method,
		headers,
		body: req.body,
	});
}

export default async function handler(req: Request): Promise<Response> {
	if (!appPromise) appPromise = init();
	try {
		const app = await appPromise;
		const response = await app.fetch(normalizeRequest(req));
		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	} catch (e: unknown) {
		console.error("[vercel] unhandled error:", e);
		return new Response(JSON.stringify({ error: "Internal server error" }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}
}
