const DATABASE_ERROR_MESSAGE = "Database query failed";
const MAX_CAUSE_DEPTH = 8;

export interface ErrorProjection {
	type: string;
	name: string;
	message: string;
	stack?: string;
}

function readProperty(value: object, key: PropertyKey): unknown {
	try {
		return Reflect.get(value, key);
	} catch {
		return undefined;
	}
}

function stringifySafely(value: unknown, fallback: string): string {
	try {
		return String(value);
	} catch {
		return fallback;
	}
}

function isDatabaseQueryError(value: unknown): boolean {
	const seen = new Set<object>();
	let current = value;

	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if ((typeof current !== "object" && typeof current !== "function") || current === null) {
			return false;
		}
		if (seen.has(current)) return false;
		seen.add(current);

		const query = readProperty(current, "query");
		const params = readProperty(current, "params");
		const message = readProperty(current, "message");
		if (
			(typeof query === "string" && params !== undefined) ||
			(typeof message === "string" &&
				message.startsWith("Failed query:") &&
				message.includes("\nparams:"))
		) {
			return true;
		}

		current = readProperty(current, "cause");
	}

	return false;
}

function sanitizeName(value: unknown): string {
	const name = typeof value === "string" ? value : "Error";
	return name.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

function sanitizeStack(stack: unknown, name: string, message: string): string | undefined {
	if (typeof stack !== "string") return undefined;

	const frames = stack.split(/\r?\n/).filter((line) => /^\s+at(?:\s|$)/.test(line));
	return frames.length > 0 ? `${name}: ${message}\n${frames.join("\n")}` : `${name}: ${message}`;
}

/**
 * Projects an arbitrary thrown value to the only fields safe for logging and tracing.
 * Drizzle query errors are recognized through wrapper causes and receive a generic
 * message because their own message and stack embed SQL and bound parameters.
 */
export function projectError(value: unknown): ErrorProjection {
	const objectValue =
		(typeof value === "object" || typeof value === "function") && value !== null
			? value
			: undefined;
	const name = sanitizeName(objectValue ? readProperty(objectValue, "name") : undefined);
	const rawMessage = objectValue
		? readProperty(objectValue, "message")
		: typeof value === "string"
			? value
			: undefined;
	const message = isDatabaseQueryError(value)
		? DATABASE_ERROR_MESSAGE
		: typeof rawMessage === "string"
			? rawMessage
			: stringifySafely(value, "Unknown error");
	const stack = sanitizeStack(
		objectValue ? readProperty(objectValue, "stack") : undefined,
		name,
		message,
	);

	return stack === undefined ? { type: name, name, message } : { type: name, name, message, stack };
}
