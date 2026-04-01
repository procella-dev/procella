import { describe, expect, test } from "bun:test";
import {
	activeUpdatesGauge,
	authAuthenticateDuration,
	authFailureCount,
	checkpointSizeHistogram,
	cryptoOperationCount,
	dbOperationCount,
	dbOperationDuration,
	gcCycleCount,
	gcOrphansCleanedCount,
	httpActiveRequestsGauge,
	httpRequestDuration,
	journalEntriesCount,
	storageOperationDuration,
	storageOperationSize,
	trpcProcedureDuration,
} from "./metrics.js";

describe("@procella/telemetry metrics", () => {
	test("httpRequestDuration returns a Histogram", () => {
		const h = httpRequestDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("httpActiveRequestsGauge returns an UpDownCounter", () => {
		const c = httpActiveRequestsGauge();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("dbOperationDuration returns a Histogram", () => {
		const h = dbOperationDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("dbOperationCount returns a Counter", () => {
		const c = dbOperationCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("cryptoOperationCount returns a Counter", () => {
		const c = cryptoOperationCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("gcCycleCount returns a Counter", () => {
		const c = gcCycleCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("gcOrphansCleanedCount returns a Counter", () => {
		const c = gcOrphansCleanedCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("activeUpdatesGauge returns an UpDownCounter", () => {
		const c = activeUpdatesGauge();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("checkpointSizeHistogram returns a Histogram", () => {
		const h = checkpointSizeHistogram();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("journalEntriesCount returns a Counter", () => {
		const c = journalEntriesCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("storageOperationDuration returns a Histogram", () => {
		const h = storageOperationDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("storageOperationSize returns a Histogram", () => {
		const h = storageOperationSize();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("authAuthenticateDuration returns a Histogram", () => {
		const h = authAuthenticateDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("authFailureCount returns a Counter", () => {
		const c = authFailureCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("trpcProcedureDuration returns a Histogram", () => {
		const h = trpcProcedureDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("all metric factories are singletons (return same instance)", () => {
		expect(httpRequestDuration()).toBe(httpRequestDuration());
		expect(dbOperationCount()).toBe(dbOperationCount());
		expect(gcCycleCount()).toBe(gcCycleCount());
		expect(activeUpdatesGauge()).toBe(activeUpdatesGauge());
		expect(trpcProcedureDuration()).toBe(trpcProcedureDuration());
	});

	test("metrics accept recording without error", () => {
		httpRequestDuration().record(42.5, { method: "GET", path: "/test", status: 200 });
		dbOperationCount().add(1, { "db.operation": "select" });
		activeUpdatesGauge().add(1);
		activeUpdatesGauge().add(-1);
		checkpointSizeHistogram().record(1024);
		// No assertions — just verifying no runtime errors
	});
});
