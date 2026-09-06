import { projectError } from "@procella/types";
import pino, { type DestinationStream } from "pino";

export function createLogger(
	destination: DestinationStream,
	level = process.env.LOG_LEVEL || "info",
) {
	return pino(
		{
			level,
			serializers: { err: projectError },
		},
		destination,
	);
}

export const logger = createLogger(pino.destination({ sync: true }));
