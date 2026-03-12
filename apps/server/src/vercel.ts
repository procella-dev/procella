// @procella/server — Vercel serverless entry point.
//
// Exports a default handler for Vercel Functions. Uses @hono/node-server/vercel
// to bridge between Vercel's Node.js runtime and Hono's Fetch API.
//
// Workaround for honojs/node-server#306: POST requests may hang on Vercel's
// Node.js runtime because the adapter doesn't fully consume the request body
// before passing it to Hono. We use handle() from the Vercel adapter which
// handles this internally.

import { handle } from "@hono/node-server/vercel";
import { app } from "./bootstrap.js";

export default handle(app);
