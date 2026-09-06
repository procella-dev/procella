const DATABASE_ERROR_MESSAGE = "Database query failed";
const MAX_CAUSE_DEPTH = 8;

export interface ErrorProjection {
	type: string;
	name: string;
	message: string;
	code?: string | number;
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

function inspectErrorChain(value: unknown): { databaseQuery: boolean; code?: string | number } {
	const seen = new Set<object>();
	let current = value;
	let code: string | number | undefined;
	let databaseQuery = false;

	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if ((typeof current !== "object" && typeof current !== "function") || current === null) {
			break;
		}
		if (seen.has(current)) break;
		seen.add(current);

		if (code === undefined) {
			const candidate = readProperty(current, "code");
			if (
				(typeof candidate === "number" && Number.isFinite(candidate)) ||
				(typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate))
			) {
				code = candidate;
			}
		}

		const query = readProperty(current, "query");
		const params = readProperty(current, "params");
		const message = readProperty(current, "message");
		if (
			(typeof query === "string" && params !== undefined) ||
			(typeof message === "string" &&
				message.startsWith("Failed query:") &&
				message.includes("\nparams:"))
		) {
			databaseQuery = true;
		}

		current = readProperty(current, "cause");
	}

	return code === undefined ? { databaseQuery } : { databaseQuery, code };
}

function sanitizeName(value: unknown): string {
	const name = typeof value === "string" ? value : "Error";
	return name.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

function deriveType(value: object | undefined, name: string): string {
	if (!value) return name;

	const errorConstructor = readProperty(value, "constructor");
	if (
		(typeof errorConstructor === "object" || typeof errorConstructor === "function") &&
		errorConstructor !== null
	) {
		const constructorName = readProperty(errorConstructor, "name");
		if (
			typeof constructorName === "string" &&
			constructorName !== "Object" &&
			/^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/.test(constructorName)
		) {
			return constructorName;
		}
	}

	const projectedType = readProperty(value, "type");
	return typeof projectedType === "string" &&
		/^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/.test(projectedType)
		? projectedType
		: name;
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
	const type = deriveType(objectValue, name);
	const rawMessage = objectValue
		? readProperty(objectValue, "message")
		: typeof value === "string"
			? value
			: undefined;
	const chain = inspectErrorChain(value);
	const message = chain.databaseQuery
		? DATABASE_ERROR_MESSAGE
		: typeof rawMessage === "string"
			? rawMessage
			: stringifySafely(value, "Unknown error");
	const stack = chain.databaseQuery
		? undefined
		: sanitizeStack(objectValue ? readProperty(objectValue, "stack") : undefined, name, message);

	const projected: ErrorProjection = { type, name, message };
	if (chain.code !== undefined) projected.code = chain.code;
	if (stack !== undefined) projected.stack = stack;
	return projected;
}
