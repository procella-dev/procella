// @procella/server — Vercel serverless entry point.
//
// Exports a default handler for Vercel Functions. Uses @hono/node-server/vercel
// to bridge between Vercel's Node.js runtime and Hono's Fetch API.
//
// Workaround for honojs/node-server#306: POST requests may hang on Vercel's
// Node.js runtime because the adapter doesn't fully consume the request body
// before passing it to Hono. We use handle() from the Vercel adapter which
// handles this internally.
//
// Lazy-init on first request to avoid cold-start overhead on unused routes.

import type { IncomingMessage, ServerResponse } from "node:http";

let handlerPromise: Promise<(req: IncomingMessage, res: ServerResponse) => void> | null = null;

function getHandler() {
	if (!handlerPromise) {
		handlerPromise = (async () => {
			const { handle } = await import("@hono/node-server/vercel");
			const { bootstrap } = await import("./bootstrap.js");
			const { app } = await bootstrap();
			return handle(app);
		})();
	}
	return handlerPromise;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
	const h = await getHandler();
	return h(req, res);
}
