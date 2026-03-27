import { handle } from "hono/aws-lambda";

let appPromise: Promise<ReturnType<typeof handle>> | null = null;

async function init() {
	const { bootstrap } = await import("./bootstrap.js");
	const { app } = await bootstrap();
	return handle(app);
}

export const handler: ReturnType<typeof handle> = async (event, lambdaContext) => {
	if (!appPromise) appPromise = init();
	const handlerFn = await appPromise;
	return handlerFn(event, lambdaContext);
};
