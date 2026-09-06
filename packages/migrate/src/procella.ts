import { listStacks as cliListStacks, parseStackFqn } from "./pulumi.js";
import type { DiscoveredStack, UntypedDeployment } from "./types.js";

const PULUMI_ACCEPT = "application/vnd.pulumi+8";

export interface RequestOptions {
	url: string;
	token: string;
}

async function request(
	method: string,
	path: string,
	opts: RequestOptions,
	body?: unknown,
): Promise<Response> {
	const url = `${opts.url.replace(/\/$/, "")}${path}`;
	const headers: Record<string, string> = {
		Accept: PULUMI_ACCEPT,
		Authorization: `token ${opts.token}`,
	};
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	return fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

/** Health check — GET /healthz */
export async function healthCheck(baseUrl: string): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`);
		return res.ok;
	} catch {
		return false;
	}
}

/** Authenticate check — GET /api/user with token */
export async function checkAuth(opts: RequestOptions): Promise<boolean> {
	try {
		const res = await request("GET", "/api/user", opts);
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Resolve the authenticated caller's real org — GET /api/user. Crypto endpoints
 * (`/decrypt`, `/batch-decrypt`) require the URL's `org` segment to match the caller's
 * actual org exactly; state endpoints (export/import/create) tolerate any value there
 * (Procella scopes stacks to the authenticated tenant, not the path's org — see
 * destination.ts). A migration's destination `org` is derived from the *source* stack
 * and is therefore not reliable for crypto calls; this resolves the real one instead.
 */
export async function getCallerOrg(opts: RequestOptions): Promise<string> {
	const res = await request("GET", "/api/user", opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to resolve caller org (${res.status}): ${text}`);
	}
	const body = (await res.json()) as { organizations?: Array<{ githubLogin?: string }> };
	return body.organizations?.[0]?.githubLogin ?? "";
}

/** List all stacks — GET /api/user/stacks */
export async function listStacks(opts: RequestOptions): Promise<DiscoveredStack[]> {
	const res = await request("GET", "/api/user/stacks", opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to list stacks (${res.status}): ${text}`);
	}

	const body = (await res.json()) as {
		stacks?: Array<{
			orgName: string;
			projectName: string;
			stackName: string;
			resourceCount?: number;
			lastUpdate?: number;
		}>;
	};

	return (body.stacks ?? []).map((s) => {
		const fqn = `${s.orgName}/${s.projectName}/${s.stackName}`;
		return {
			fqn,
			ref: { org: s.orgName, project: s.projectName, stack: s.stackName },
			resourceCount: s.resourceCount ?? null,
			lastUpdate: s.lastUpdate ? new Date(s.lastUpdate * 1000).toISOString() : null,
		};
	});
}

/**
 * Create a stack on Procella — POST /api/stacks/:org/:project/:stack
 * Idempotent: returns true if created, false if already exists.
 */
export async function createStack(
	opts: RequestOptions,
	org: string,
	project: string,
	stack: string,
): Promise<{ created: boolean }> {
	const res = await request("POST", `/api/stacks/${org}/${project}/${stack}`, opts, {});
	if (res.ok) {
		await res.body?.cancel();
		return { created: true };
	}
	if (res.status === 409) {
		await res.body?.cancel();
		return { created: false }; // already exists
	}

	const text = await res.text();
	throw new Error(`Failed to create stack ${org}/${project}/${stack} (${res.status}): ${text}`);
}

/** Export state from a stack — GET /api/stacks/:org/:project/:stack/export */
export async function exportState(
	opts: RequestOptions,
	org: string,
	project: string,
	stack: string,
): Promise<UntypedDeployment> {
	const res = await request("GET", `/api/stacks/${org}/${project}/${stack}/export`, opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Failed to export state for ${org}/${project}/${stack} (${res.status}): ${text}`,
		);
	}
	return (await res.json()) as UntypedDeployment;
}

/**
 * Decrypt a batch of secret ciphertexts through a stack's own secret provider —
 * POST /api/stacks/:org/:project/:stack/batch-decrypt. Used to compare secret values by
 * decrypted logical content instead of ciphertext (which legitimately differs whenever a
 * stack is re-encrypted under a different provider, e.g. after migration).
 *
 * Returns a map from ciphertext to decrypted plaintext (UTF-8 decoded). Ciphertexts this
 * stack's provider cannot decrypt are simply absent from the result.
 */
// apps/server/src/handlers/schemas.ts MAX_BATCH_CRYPT_ITEMS — the server rejects a single
// batch-decrypt request larger than this with 400, so a deployment with more distinct
// secrets than this must be split across multiple requests.
const MAX_BATCH_DECRYPT_ITEMS = 1000;

export async function batchDecrypt(
	opts: RequestOptions,
	org: string,
	project: string,
	stack: string,
	ciphertexts: string[],
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (let i = 0; i < ciphertexts.length; i += MAX_BATCH_DECRYPT_ITEMS) {
		const chunk = ciphertexts.slice(i, i + MAX_BATCH_DECRYPT_ITEMS);
		const res = await request(
			"POST",
			`/api/stacks/${org}/${project}/${stack}/batch-decrypt`,
			opts,
			{ ciphertexts: chunk },
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(
				`Failed to batch-decrypt secrets for ${org}/${project}/${stack} (${res.status}): ${text}`,
			);
		}

		const body = (await res.json()) as { plaintexts?: Record<string, string> };
		for (const [ciphertext, plaintextBase64] of Object.entries(body.plaintexts ?? {})) {
			result.set(ciphertext, Buffer.from(plaintextBase64, "base64").toString("utf-8"));
		}
	}
	return result;
}

/**
 * List stacks matching a filter pattern.
 * A bare `*` matches everything. Otherwise `*` matches within a segment and `**` matches across slashes.
 */
export function filterStacks(
	stacks: DiscoveredStack[],
	pattern: string,
	exclude?: string,
): DiscoveredStack[] {
	const include = globToRegex(pattern);
	const exc = exclude ? globToRegex(exclude) : null;
	return stacks.filter((s) => {
		if (!include.test(s.fqn)) return false;
		if (exc?.test(s.fqn)) return false;
		return true;
	});
}

function globToRegex(pattern: string): RegExp {
	if (pattern === "*") return /^.*$/;
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/{{GLOBSTAR}}/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * Discover stacks on either a Procella instance (via API) or another backend (via CLI).
 * Heuristic: if the URL starts with http(s), try Procella API first, fall back to CLI.
 */
export async function discoverStacks(url: string, token: string): Promise<DiscoveredStack[]> {
	if (url.startsWith("http://") || url.startsWith("https://")) {
		try {
			return await listStacks({ url, token });
		} catch {
			// Fall back to CLI — might be Pulumi Cloud or another service backend
		}
	}

	return cliListStacks({ backendUrl: url, token });
}

/** Parse an FQN from a CLI-returned stack name (which may omit the org). */
export function ensureStackRef(fqn: string, defaultOrg: string): DiscoveredStack["ref"] {
	const ref = parseStackFqn(fqn);
	if (!ref.org && defaultOrg) {
		return { ...ref, org: defaultOrg };
	}
	return ref;
}
