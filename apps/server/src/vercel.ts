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
// bootstrap.ts uses top-level await (async createDb), which causes
// "Requested module is not instantiated yet" errors with static imports
// on Vercel's Bun runtime. Lazy-init on first request avoids this.

import type { IncomingMessage, ServerResponse } from "node:http";

let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

async function getHandler() {
	if (!handler) {
		const { handle } = await import("@hono/node-server/vercel");
		const { app } = await import("./bootstrap.js");
		handler = handle(app);
	}
	return handler;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
	const h = await getHandler();
	return h(req, res);
}
