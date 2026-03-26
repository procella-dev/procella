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
	return new Request(req.url, {
		method: req.method,
		headers: new Headers(req.headers as unknown as Record<string, string>),
		body: req.body,
	});
}

export default async function fetch(req: Request): Promise<Response> {
	if (!appPromise) appPromise = init();
	const app = await appPromise;
	return app.fetch(normalizeRequest(req));
}
