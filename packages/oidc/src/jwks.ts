import { isBlockedHostname, validateUrl } from "@procella/webhooks";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JwksValidator } from "./types.js";

type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

export class JwksValidatorImpl implements JwksValidator {
	private cache = new Map<string, RemoteJWKSet>();
	private discoveredJwksUris = new Map<string, string>();
	private readonly maxCacheSize: number;
	/** Allow HTTP issuers — for testing only, never set in production. */
	private readonly allowHttp: boolean;

	constructor(opts?: { maxCacheSize?: number; allowHttp?: boolean }) {
		this.maxCacheSize = opts?.maxCacheSize ?? 100;
		this.allowHttp = opts?.allowHttp ?? false;
	}

	async verify(
		jwt: string,
		expectedIssuer: string,
		expectedAudience: string,
	): Promise<Record<string, unknown>> {
		const jwks = await this.getOrCreateJwks(expectedIssuer);
		try {
			const { payload } = await jwtVerify(jwt, jwks, {
				algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
				issuer: expectedIssuer,
				audience: expectedAudience,
			});
			return payload as Record<string, unknown>;
		} catch (err) {
			if (err instanceof joseErrors.JWTExpired) {
				throw new JwksValidationError("token_expired", `JWT expired: ${err.message}`);
			}
			if (err instanceof joseErrors.JWTClaimValidationFailed) {
				throw new JwksValidationError(
					"claim_validation_failed",
					`Claim validation failed: ${err.claim} - ${err.reason}`,
				);
			}
			if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
				throw new JwksValidationError("signature_invalid", "JWT signature verification failed");
			}
			if (err instanceof joseErrors.JWKSNoMatchingKey) {
				throw new JwksValidationError("no_matching_key", "No matching key found in JWKS");
			}
			throw err;
		}
	}

	private async getOrCreateJwks(issuer: string): Promise<RemoteJWKSet> {
		let jwks = this.cache.get(issuer);
		if (!jwks) {
			if (this.cache.size >= this.maxCacheSize) {
				const firstKey = this.cache.keys().next().value;
				if (firstKey) {
					this.cache.delete(firstKey);
					this.discoveredJwksUris.delete(firstKey);
				}
			}
			const jwksUrl = new URL(await this.discoverJwksUri(issuer));
			jwks = createRemoteJWKSet(jwksUrl);
			this.cache.set(issuer, jwks);
		}
		return jwks;
	}

	private async discoverJwksUri(issuer: string): Promise<string> {
		if (!this.allowHttp && !issuer.startsWith("https://")) {
			throw new JwksValidationError("invalid_issuer", `Issuer must use HTTPS, got: ${issuer}`);
		}
		if (!this.allowHttp) {
			this.validateSsrf(issuer, "Issuer");
		}

		const cached = this.discoveredJwksUris.get(issuer);
		if (cached) {
			return cached;
		}

		const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
		const configUrl = new URL(".well-known/openid-configuration", base);
		const resp = await fetch(configUrl.toString(), {
			signal: AbortSignal.timeout(5000),
			redirect: "manual",
		});
		if (!resp.ok) {
			throw new JwksValidationError(
				"discovery_failed",
				`Failed to fetch OIDC configuration from ${configUrl}`,
			);
		}

		const config = (await resp.json()) as Record<string, unknown>;
		const jwksUri = config.jwks_uri;
		if (typeof jwksUri !== "string") {
			throw new JwksValidationError("discovery_failed", "OIDC configuration missing jwks_uri");
		}
		if (!this.allowHttp && !jwksUri.startsWith("https://")) {
			throw new JwksValidationError("discovery_failed", `jwks_uri must use HTTPS, got: ${jwksUri}`);
		}
		if (!this.allowHttp) {
			this.validateSsrf(jwksUri, "jwks_uri");
		}

		this.discoveredJwksUris.set(issuer, jwksUri);
		return jwksUri;
	}

	private validateSsrf(url: string, label: string): void {
		try {
			validateUrl(url, label);
			const parsed = new URL(url);
			const hostname = parsed.hostname.toLowerCase();
			if (isBlockedHostname(hostname)) {
				throw new JwksValidationError(
					"ssrf_blocked",
					`${label} URL uses a blocked DNS rebinding service: ${hostname}`,
				);
			}
		} catch (err) {
			if (err instanceof JwksValidationError) throw err;
			throw new JwksValidationError(
				"ssrf_blocked",
				`${label} URL blocked by SSRF guard: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	dispose(): void {
		this.cache.clear();
		this.discoveredJwksUris.clear();
	}
}

export class JwksValidationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "JwksValidationError";
	}
}
