/**
 * Strictly validate a CLI session port string.
 * Returns a valid port number (1024–65535) or null.
 * Rejects non-canonical decimals, floats, hex, octal, leading/trailing whitespace,
 * and userinfo-syntax attacks like "1234@evil.com".
 */
export function parsePort(raw: string | null): number | null {
	if (raw == null || raw === "") return null;
	if (!/^[1-9]\d*$/.test(raw)) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
	return n;
}
