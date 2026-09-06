import type { ScheduledEvent } from "aws-lambda";

const LAMBDA_WORK_DEADLINE_MS = 52_000;

interface GcWorkerLike {
	runOnce(): Promise<void>;
}

interface GitHubOutboxLike {
	runOnce(options: { deadlineMs: number }): Promise<unknown>;
}

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GcInvocationDependencies {
	baseUrl: string;
	requestId: string;
	gcWorker: GcWorkerLike;
	githubOutbox: GitHubOutboxLike | null;
	escGcSweep: () => Promise<unknown>;
	flushTelemetry: () => Promise<void>;
	runtimeFetch?: RuntimeFetch;
}

async function flushSafely(flushTelemetry: () => Promise<void>): Promise<void> {
	try {
		await flushTelemetry();
	} catch (error) {
		console.error("[gc] telemetry flush failed:", error);
	}
}

export async function runGcInvocation({
	baseUrl,
	requestId,
	gcWorker,
	githubOutbox,
	escGcSweep,
	flushTelemetry,
	runtimeFetch = fetch,
}: GcInvocationDependencies): Promise<void> {
	const invocationStartedAt = Date.now();

	try {
		await gcWorker.runOnce();
		if (githubOutbox) {
			await githubOutbox.runOnce({
				deadlineMs: invocationStartedAt + LAMBDA_WORK_DEADLINE_MS,
			});
		}
		await escGcSweep();
		await flushSafely(flushTelemetry);
		await runtimeFetch(`${baseUrl}/invocation/${requestId}/response`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "ok" }),
		});
	} catch (err: unknown) {
		const error = err instanceof Error ? err : new Error(String(err));
		await flushSafely(flushTelemetry);
		await runtimeFetch(`${baseUrl}/invocation/${requestId}/error`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				errorMessage: error.message,
				errorType: error.name,
				stackTrace: error.stack?.split("\n") || [],
			}),
		});
	}
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
		{ GCWorker },
	] = await Promise.all([
		import("@procella/db"),
		import("@procella/esc"),
		import("@procella/github"),
		import("@procella/updates"),
	]);
	const { db } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });
	const gcWorker = new GCWorker({ db });
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

	while (true) {
		const res = await fetch(`${baseUrl}/invocation/next`);
		const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		void ((await res.json()) as ScheduledEvent);

		await runGcInvocation({
			baseUrl,
			requestId,
			gcWorker,
			githubOutbox,
			escGcSweep: () => escGcSweep(db),
			flushTelemetry,
		});
	}
}

if (import.meta.main) {
	await main();
}
