import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { BadRequestError } from "@procella/types";

// ============================================================================
// SSRF Protection — shared URL validator
// ============================================================================

const NON_GLOBAL_IPV4_RANGES = [
	[0x00000000, 8], // Current network
	[0x0a000000, 8], // Private-use
	[0x64400000, 10], // Shared address space
	[0x7f000000, 8], // Loopback
	[0xa9fe0000, 16], // Link-local
	[0xac100000, 12], // Private-use
	[0xc0000000, 24], // IETF protocol assignments
	[0xc0000200, 24], // TEST-NET-1
	[0xc0586300, 24], // Deprecated 6to4 relay anycast
	[0xc0a80000, 16], // Private-use
	[0xc6120000, 15], // Benchmarking
	[0xc6336400, 24], // TEST-NET-2
	[0xcb007100, 24], // TEST-NET-3
	[0xe0000000, 3], // Multicast and reserved space
] as const;

const NON_GLOBAL_IPV6_RANGES = [
	[0x20010000000000000000000000000000n, 23], // IETF protocol assignments
	[0x20010db8000000000000000000000000n, 32], // Documentation
	[0x20020000000000000000000000000000n, 16], // 6to4
	[0x3fff0000000000000000000000000000n, 20], // Documentation
] as const;

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

function parseIpv4(address: string): number {
	return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function parseIpv6(address: string): bigint {
	let normalized = address;
	const lastColon = normalized.lastIndexOf(":");
	if (normalized.includes(".")) {
		const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
		normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(
			ipv4 & 0xffff
		).toString(16)}`;
	}

	const halves = normalized.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const groups =
		halves.length === 1
			? left
			: [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];

	return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv4Range(address: number, start: number, prefixLength: number): boolean {
	return address >= start && address < start + 2 ** (32 - prefixLength);
}

function isInIpv6Range(address: bigint, start: bigint, prefixLength: number): boolean {
	return address >= start && address < start + (1n << BigInt(128 - prefixLength));
}

function isGlobalUnicastIp(raw: string): boolean {
	const bare = stripBrackets(raw);
	const family = isIP(bare);
	if (family === 4) {
		const address = parseIpv4(bare);
		return !NON_GLOBAL_IPV4_RANGES.some(([start, prefix]) => isInIpv4Range(address, start, prefix));
	}

	if (family === 6) {
		const address = parseIpv6(bare);
		const isAllocatedGlobalUnicast =
			address >= 0x20000000000000000000000000000000n &&
			address < 0x40000000000000000000000000000000n;
		return (
			isAllocatedGlobalUnicast &&
			!NON_GLOBAL_IPV6_RANGES.some(([start, prefix]) => isInIpv6Range(address, start, prefix))
		);
	}

	return false;
}

export function isPrivateIp(raw: string): boolean {
	const bare = stripBrackets(raw);
	return isIP(bare) !== 0 && !isGlobalUnicastIp(bare);
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
		if (!isGlobalUnicastIp(addr)) {
			throw new BadRequestError(
				`${label} URL hostname resolves to a private or reserved IP address`,
			);
		}
	}
}
