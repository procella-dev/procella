import type { ScheduledEvent } from "aws-lambda";
import { drainOutboxes } from "./outbox-drain.js";

const LAMBDA_WORK_DEADLINE_MS = 52_000;
const TELEMETRY_FLUSH_TIMEOUT_MS = 3_000;

interface GcWorkerLike {
	runOnce(): Promise<void>;
}

interface OutboxLike {
	runOnce(options: { deadlineMs: number }): Promise<unknown>;
}

interface BlobCleanupLike {
	runOnce(options: { deadlineMs: number }): Promise<unknown>;
}

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GcInvocationDependencies {
	baseUrl: string;
	requestId: string;
	gcWorker: GcWorkerLike;
	blobCleanup: BlobCleanupLike;
	githubOutbox: OutboxLike | null;
	webhookOutbox: OutboxLike;
	escGcSweep: () => Promise<unknown>;
	flushTelemetry: () => Promise<void>;
	runtimeFetch?: RuntimeFetch;
}

async function flushSafely(flushTelemetry: () => Promise<void>): Promise<void> {
	const { promise: timedOut, resolve: finishTimeout } = Promise.withResolvers<void>();
	const timeout = setTimeout(finishTimeout, TELEMETRY_FLUSH_TIMEOUT_MS);
	try {
		await Promise.race([flushTelemetry(), timedOut]);
	} catch (error) {
		console.error("[gc] telemetry flush failed:", error);
	} finally {
		clearTimeout(timeout);
	}
}

export async function runGcInvocation({
	baseUrl,
	requestId,
	gcWorker,
	blobCleanup,
	githubOutbox,
	webhookOutbox,
	escGcSweep,
	flushTelemetry,
	runtimeFetch = fetch,
}: GcInvocationDependencies): Promise<void> {
	const invocationStartedAt = Date.now();
	let invocationError: unknown;
	let failed = false;

	try {
		await gcWorker.runOnce();
	} catch (error) {
		failed = true;
		invocationError = error;
	}
	if (githubOutbox) {
		try {
			await githubOutbox.runOnce({
				deadlineMs: invocationStartedAt + LAMBDA_WORK_DEADLINE_MS,
			});
		} catch (error) {
			failed = true;
			invocationError ??= error;
		}
	}
	try {
		await webhookOutbox.runOnce({
			deadlineMs: invocationStartedAt + LAMBDA_WORK_DEADLINE_MS,
		});
	} catch (error) {
		failed = true;
		invocationError ??= error;
	}
	try {
		await blobCleanup.runOnce({
			deadlineMs: invocationStartedAt + LAMBDA_WORK_DEADLINE_MS,
		});
	} catch (error) {
		failed = true;
		invocationError ??= error;
	}
	try {
		await escGcSweep();
	} catch (error) {
		failed = true;
		invocationError ??= error;
	}

	await flushSafely(flushTelemetry);
	if (failed) {
		const error =
			invocationError instanceof Error ? invocationError : new Error(String(invocationError));
		await runtimeFetch(`${baseUrl}/invocation/${requestId}/error`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				errorMessage: error.message,
				errorType: error.name,
				stackTrace: error.stack?.split("\n") || [],
			}),
		});
		return;
	}

	await runtimeFetch(`${baseUrl}/invocation/${requestId}/response`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "ok" }),
	});
}

async function main(): Promise<void> {
	const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API!;
	const baseUrl = `http://${runtimeApi}/2018-06-01/runtime`;

	// Initialize telemetry before loading workers that cache metric instruments.
	const { loadConfig } = await import("@procella/config");

	const config = loadConfig();
	const { flushTelemetry, initTelemetry } = await import("@procella/telemetry");
	initTelemetry({ enabled: config.otelEnabled, serviceName: "procella-gc" });

	const [
		{ createDb },
		{ escGcSweep },
		{ GitHubOutboxWorker, OctokitGitHubDeliveryService },
		{ createBlobStorage },
		{ WebhookOutboxWorker },
		{ BlobCleanupWorker, GCWorker },
	] = await Promise.all([
		import("@procella/db"),
		import("@procella/esc"),
		import("@procella/github"),
		import("@procella/storage"),
		import("@procella/webhooks"),
		import("@procella/updates"),
	]);
	const { db } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });
	const gcWorker = new GCWorker({ db });
	const storage = createBlobStorage(
		config.blobBackend === "local"
			? { backend: "local", basePath: config.blobLocalPath }
			: {
					backend: "s3",
					bucket: config.blobS3Bucket as string,
					endpoint: config.blobS3Endpoint,
					region: config.blobS3Region,
					accessKeyId: process.env.AWS_ACCESS_KEY_ID,
					secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
				},
	);
	const blobCleanup = new BlobCleanupWorker({ db, storage, maxPerRun: 100 });
	const githubAppId = process.env.PROCELLA_GITHUB_DELIVERY_APP_ID;
	const githubPrivateKey = process.env.PROCELLA_GITHUB_DELIVERY_PRIVATE_KEY?.replace(/\\n/g, "\n");
	if (Boolean(githubAppId) !== Boolean(githubPrivateKey)) {
		throw new Error("GitHub delivery requires both App ID and private key");
	}
	const githubOutbox =
		githubAppId && githubPrivateKey
			? new GitHubOutboxWorker({
					db,
					github: new OctokitGitHubDeliveryService({
						db,
						config: { appId: githubAppId, privateKey: githubPrivateKey },
					}),
					maxPerRun: 5,
				})
			: null;
	const webhookOutbox = new WebhookOutboxWorker({ db, maxPerRun: 5 });

	while (true) {
		const res = await fetch(`${baseUrl}/invocation/next`);
		const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		void ((await res.json()) as ScheduledEvent);

		await runGcInvocation({
			baseUrl,
			requestId,
			gcWorker,
			blobCleanup,
			githubOutbox,
			webhookOutbox,
			escGcSweep: () => escGcSweep(db),
			flushTelemetry,
		});
	}
}

if (import.meta.main) {
	await main();
}
