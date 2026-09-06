import { projectError } from "@procella/types";

interface OneShotOutbox {
	runOnce(options: { deadlineMs: number }): Promise<number>;
}

/**
 * Drain independent outboxes without letting one integration suppress the other or later
 * scheduled maintenance. Both promises are still awaited before the runtime completes.
 */
export async function drainOutboxes({
	github,
	webhook,
	deadlineMs,
	onError = (name, error) => console.error(`[outbox] ${name} drain failed`, projectError(error)),
}: {
	github?: OneShotOutbox | null;
	webhook: OneShotOutbox;
	deadlineMs: number;
	onError?: (name: "GitHub" | "webhook", error: unknown) => void;
}): Promise<void> {
	await Promise.all([
		github?.runOnce({ deadlineMs }).catch((error) => onError("GitHub", error)),
		webhook.runOnce({ deadlineMs }).catch((error) => onError("webhook", error)),
	]);
}
