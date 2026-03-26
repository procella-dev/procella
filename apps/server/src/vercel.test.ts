import { describe, expect, test } from "bun:test";
import { normalizeRequest } from "./vercel.js";

describe("normalizeRequest", () => {
	test("returns standard Request unchanged", () => {
		const req = new Request("https://example.com/api/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
		});
		const result = normalizeRequest(req);
		expect(result).toBe(req);
	});

	test("reconstructs Request when headers is a plain object", () => {
		const fakeReq = {
			url: "/api/auth/config",
			method: "GET",
			headers: {
				host: "app.procella.sh",
				"x-forwarded-proto": "https",
				accept: "application/json",
			},
			body: null,
		} as unknown as Request;

		const result = normalizeRequest(fakeReq);

		expect(result).toBeInstanceOf(Request);
		expect(result.headers).toBeInstanceOf(Headers);
		expect(result.url).toBe("https://app.procella.sh/api/auth/config");
		expect(result.method).toBe("GET");
		expect(result.headers.get("accept")).toBe("application/json");
		expect(result.headers.get("host")).toBe("app.procella.sh");
	});

	test("defaults to https://localhost when host header is missing", () => {
		const fakeReq = {
			url: "/healthz",
			method: "GET",
			headers: {},
			body: null,
		} as unknown as Request;

		const result = normalizeRequest(fakeReq);
		expect(result.url).toBe("https://localhost/healthz");
	});

	test("preserves absolute URLs", () => {
		const fakeReq = {
			url: "https://custom.domain.com/api/test",
			method: "PUT",
			headers: { host: "custom.domain.com" },
			body: null,
		} as unknown as Request;

		const result = normalizeRequest(fakeReq);
		expect(result.url).toBe("https://custom.domain.com/api/test");
		expect(result.method).toBe("PUT");
	});
});
