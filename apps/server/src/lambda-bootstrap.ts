/// <reference types="aws-lambda" />
import type { Handler } from "aws-lambda";

const { bootstrap } = await import("./bootstrap.js");
const { app } = await bootstrap();
const { streamHandle } = await import("hono/aws-lambda");

export const handler: Handler = streamHandle(app);
