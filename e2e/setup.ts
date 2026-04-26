// E2E test lifecycle — docker compose deps + server before all tests.

import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import type { Subprocess } from "bun";
import {
	ensureDeps,
	resetDatabase,
	startServer,
	stopServer,
	TEST_TICKET_SIGNING_KEY,
} from "./helpers.js";
import { warmupServer } from "./warmup.js";

process.env.PROCELLA_AUTH_MODE ??= "dev";
process.env.PROCELLA_ENCRYPTION_KEY ??= "c".repeat(64);
process.env.PROCELLA_TICKET_SIGNING_KEY ??= TEST_TICKET_SIGNING_KEY;
process.env.PROCELLA_CRON_SECRET ??= "e2e-cron-secret";

setDefaultTimeout(120_000);

let server: Subprocess;

beforeAll(async () => {
	await ensureDeps();
	await resetDatabase();
	server = await startServer();
	await warmupServer();
});

afterAll(async () => {
	if (server) {
		await stopServer(server);
	}
});
