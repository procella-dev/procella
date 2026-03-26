// E2E — Health, capabilities, and CLI version endpoints (public, no auth).

import { describe, expect, test } from "bun:test";
import { BACKEND_URL } from "./helpers.js";

describe("health and capabilities", () => {
	test("GET /healthz returns 200 with status ok", async () => {
		const res = await fetch(`${BACKEND_URL}/healthz`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	test("GET /api/capabilities returns expected capabilities", async () => {
		const res = await fetch(`${BACKEND_URL}/api/capabilities`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.capabilities).toBeArray();
		const names = body.capabilities.map((c: { capability: string }) => c.capability);
		expect(names).toContain("batch-encrypt");
		expect(names).toContain("deployment-schema-version");
	});

	test("GET /api/cli/version returns version info", async () => {
		const res = await fetch(`${BACKEND_URL}/api/cli/version`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("latestVersion");
		expect(body).toHaveProperty("oldestWithoutWarning");
	});
});
