import { describe, expect, mock, spyOn, test } from "bun:test";
import * as telemetry from "@procella/telemetry";
import { BadRequestError } from "@procella/types";
import { PostgresUpdatesService } from "./postgres.js";

describe("PostgresUpdatesService.completeUpdate status validation", () => {
	test("rejects non-terminal and unknown statuses before mutating state or metrics", async () => {
		const transaction = mock(async () => {
			throw new Error("transaction must not run");
		});
		const add = mock(() => {});
		const activeUpdatesGauge = spyOn(telemetry, "activeUpdatesGauge").mockReturnValue({
			add,
		} as never);
		const service = new PostgresUpdatesService({
			db: { transaction } as never,
			storage: {} as never,
			crypto: {} as never,
		});

		for (const status of ["not started", "requested", "running", "paused"]) {
			try {
				await service.completeUpdate("update-1", { status });
				expect.unreachable("non-terminal status must be rejected");
			} catch (error) {
				expect(error).toBeInstanceOf(BadRequestError);
			}
		}

		expect(transaction).not.toHaveBeenCalled();
		expect(activeUpdatesGauge).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
		activeUpdatesGauge.mockRestore();
	});
});
