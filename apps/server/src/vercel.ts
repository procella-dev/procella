let appPromise: ReturnType<typeof init> | null = null;

async function init() {
	const { bootstrap } = await import("./bootstrap.js");
	const { app } = await bootstrap();
	return app;
}

/**
 * Vercel's Bun runtime may pass a Request whose `headers` is a plain
 * object (missing .get/.set/.has) rather than a proper Headers instance.
 * Reconstruct with real Headers so Hono's middleware chain works.
 *
 * See: remix-i18next#117, oven-sh/bun#9846
 */
function normalizeRequest(req: Request): Request {
	if (typeof req.headers?.get === "function") return req;

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

export default async function fetch(req: Request): Promise<Response> {
	if (!appPromise) appPromise = init();
	try {
		const app = await appPromise;
		return app.fetch(normalizeRequest(req));
	} catch (e: unknown) {
		console.error("[vercel] bootstrap failed:", e);
		const msg = e instanceof Error ? e.message : String(e);
		const stack = e instanceof Error ? e.stack : undefined;
		return new Response(JSON.stringify({ error: msg, stack }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}
}
