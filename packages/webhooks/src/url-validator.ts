import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { BadRequestError } from "@procella/types";

// ============================================================================
// SSRF Protection — shared URL validator
// ============================================================================

const PRIVATE_IPV4_PATTERNS = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^0\./,
];

const PRIVATE_IPV6_PATTERNS = [/^::1$/, /^fc00:/i, /^fe80:/i, /^fd[0-9a-f]{2}:/i];

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [".nip.io", ".sslip.io", ".xip.io", ".localtest.me", ".lvh.me"];

function stripBrackets(hostname: string): string {
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return hostname.slice(1, -1);
	}
	return hostname;
}

function ipv4MappedToIpv4(ipv6: string): string | null {
	const match = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!match) return null;
	const hi = Number.parseInt(match[1], 16);
	const lo = Number.parseInt(match[2], 16);
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIp(raw: string): boolean {
	const bare = stripBrackets(raw);

	if (isIP(bare) === 4) {
		return PRIVATE_IPV4_PATTERNS.some((p) => p.test(bare));
	}

	if (isIP(bare) === 6) {
		if (PRIVATE_IPV6_PATTERNS.some((p) => p.test(bare))) return true;
		const mapped = ipv4MappedToIpv4(bare);
		if (mapped) return PRIVATE_IPV4_PATTERNS.some((p) => p.test(mapped));
		return false;
	}

	return false;
}

export function isBlockedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (BLOCKED_HOSTNAMES.has(lower)) return true;
	if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
	return false;
}

export function validateUrl(url: string, label: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BadRequestError(`Invalid ${label} URL`);
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new BadRequestError(`${label} URL must use HTTP or HTTPS`);
	}

	const hostname = parsed.hostname.toLowerCase();
	if (BLOCKED_HOSTNAMES.has(hostname)) {
		throw new BadRequestError(`${label} URL cannot target private or metadata addresses`);
	}

	if (isPrivateIp(hostname)) {
		throw new BadRequestError(`${label} URL cannot target private or reserved IP addresses`);
	}

	return parsed;
}

export async function resolveAndValidateUrl(url: string, label: string): Promise<void> {
	const parsed = validateUrl(url, label);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

	if (isBlockedHostname(hostname)) {
		throw new BadRequestError(`${label} URL uses a blocked DNS rebinding service`);
	}

	if (isIP(hostname)) return;

	const [v4, v6] = await Promise.all([
		resolve4(hostname).catch((): string[] => []),
		resolve6(hostname).catch((): string[] => []),
	]);
	const addresses = [...v4, ...v6];

	if (addresses.length === 0) {
		throw new BadRequestError(`${label} URL hostname could not be resolved`);
	}

	for (const addr of addresses) {
		if (isPrivateIp(addr)) {
			throw new BadRequestError(
				`${label} URL hostname resolves to a private or reserved IP address`,
			);
		}
	}
}
