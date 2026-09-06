export const MIGRATIONS_ADVISORY_LOCK_ID = 5_796_818_143_073_299_553n; // "Procella"

/** Use Neon's direct endpoint so a session advisory lock remains connection-affine. */
export function getDirectNeonMigrationUrl(url: string): string {
	const parsed = new URL(url);
	const labels = parsed.hostname.toLowerCase().split(".");
	const endpoint = labels[0];
	if (!endpoint?.endsWith("-pooler")) return url;

	labels[0] = endpoint.slice(0, -"-pooler".length);
	parsed.hostname = labels.join(".");
	return parsed.toString();
}

/** Release the session lock without replacing an in-flight migration error. */
export async function releaseMigrationLock(
	locked: boolean,
	unlock: () => Promise<unknown>,
	release: () => void,
): Promise<void> {
	try {
		if (locked) await unlock();
	} catch {
		// Closing the session releases the lock when an explicit unlock is no longer possible.
	} finally {
		release();
	}
}
