import { bootstrap } from "./bootstrap.js";

const { app } = await bootstrap();
const port = Number(process.env.PORT || 8080);

Bun.serve({
	fetch: app.fetch,
	port,
	hostname: "0.0.0.0",
});

console.log(`Procella listening on :${port}`);
