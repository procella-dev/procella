import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { bootstrap } = await import("./bootstrap.js");
	const { app } = await bootstrap();
	const { handle } = await import("hono/aws-lambda");
	const honoHandler = handle(app);

	while (true) {
		const res = await fetch(`${BASE_URL}/invocation/next`);
		const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		const deadline = res.headers.get("Lambda-Runtime-Deadline-Ms");
		const event = (await res.json()) as APIGatewayProxyEventV2;

		const context: Context = {
			functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || "",
			functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || "$LATEST",
			invokedFunctionArn: res.headers.get("Lambda-Runtime-Invoked-Function-Arn") || "",
			memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || "128",
			awsRequestId: requestId,
			logGroupName: process.env.AWS_LAMBDA_LOG_GROUP_NAME || "",
			logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME || "",
			getRemainingTimeInMillis: () => Number(deadline) - Date.now(),
			callbackWaitsForEmptyEventLoop: true,
			done: () => {},
			fail: () => {},
			succeed: () => {},
		};

		try {
			const result = await honoHandler(
				event as unknown as Parameters<typeof honoHandler>[0],
				context as Parameters<typeof honoHandler>[1],
			);
			await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(result),
			});
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			await fetch(`${BASE_URL}/invocation/${requestId}/error`, {
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
})();
