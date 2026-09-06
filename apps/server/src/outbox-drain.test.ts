import { describe, expect, mock, test } from "bun:test";
import { drainOutboxes } from "./outbox-drain.js";

describe("drainOutboxes", () => {
	test("isolates one failed drain and still awaits its sibling", async () => {
		const githubError = new Error("github unavailable");
		const github = { runOnce: mock(async () => Promise.reject(githubError)) };
		const webhookFinished = Promise.withResolvers<void>();
		const webhook = {
			runOnce: mock(async () => {
				await webhookFinished.promise;
				return 1;
			}),
		};
		const onError = mock(() => {});

		const draining = drainOutboxes({ github, webhook, deadlineMs: 42_000, onError });
		await Promise.resolve();
		expect(webhook.runOnce).toHaveBeenCalledWith({ deadlineMs: 42_000 });
		webhookFinished.resolve();
		await draining;
		expect(onError).toHaveBeenCalledWith("GitHub", githubError);
	});
});
