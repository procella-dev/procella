// E2E test lifecycle — docker compose deps + server before all tests.

import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import type { Subprocess } from "bun";
import { ensureDeps, resetDatabase, startServer, stopServer } from "./helpers.js";

setDefaultTimeout(120_000);

let server: Subprocess;

beforeAll(async () => {
	await ensureDeps();
	await resetDatabase();
	server = await startServer();
});

afterAll(async () => {
	if (server) {
		await stopServer(server);
	}
});
