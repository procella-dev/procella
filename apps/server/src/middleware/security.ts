import type { Context, MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { MemoryStore, rateLimiter } from "hono-rate-limiter";
import type { Env } from "../types.js";

const ONE_MINUTE_MS = 60_000;

export const INTERNAL_CLIENT_IP_HEADER = "x-procella-client-ip";

export function createSecurityHeadersMiddleware(): MiddlewareHandler<Env> {
	return secureHeaders({
		contentSecurityPolicy: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'", "'unsafe-inline'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:", "https:"],
			fontSrc: ["'self'", "data:", "https:"],
			connectSrc: ["'self'", "https://*.descope.com"],
			frameSrc: ["'self'", "https://*.descope.com"],
		},
		xFrameOptions: "DENY",
		referrerPolicy: "no-referrer",
		strictTransportSecurity: "max-age=31536000; includeSubDomains",
	});
}

export function createIpRateLimiter(options: {
	limit: number;
	skip?: (c: Context<Env>) => boolean | Promise<boolean>;
}): MiddlewareHandler<Env> {
	return rateLimiter<Env>({
		windowMs: ONE_MINUTE_MS,
		limit: options.limit,
		standardHeaders: "draft-6",
		keyGenerator: (c) => getClientIp(c) ?? "unknown",
		skip: options.skip ?? (() => false),
		message: { error: "Too many requests" },
		// Process-local only; swap to a shared Redis store in clustered production.
		store: new MemoryStore<Env>(),
	});
}

export function getClientIp(c: Context<Env>): string | undefined {
	const directIp = getHeaderIp(c.req.raw.headers, INTERNAL_CLIENT_IP_HEADER);
	if (process.env.PROCELLA_TRUST_PROXY === "true") {
		return (
			getHeaderIp(c.req.raw.headers, "x-forwarded-for") ??
			getHeaderIp(c.req.raw.headers, "x-real-ip") ??
			directIp
		);
	}
	return directIp;
}

export function withInternalClientIp(
	request: Request,
	clientIp: string | null | undefined,
): Request {
	if (!clientIp) {
		return request;
	}
	const headers = new Headers(request.headers);
	headers.set(INTERNAL_CLIENT_IP_HEADER, clientIp);
	return new Request(request, { headers });
}

function getHeaderIp(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	if (!value) {
		return undefined;
	}
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.at(-1);
}
