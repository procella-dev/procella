let appPromise: ReturnType<typeof init> | null = null;

async function init() {
	const { bootstrap } = await import("./bootstrap.js");
	const { app } = await bootstrap();
	return app;
}

export default async function fetch(req: Request): Promise<Response> {
	if (!appPromise) appPromise = init();
	const app = await appPromise;
	return app.fetch(req);
}
