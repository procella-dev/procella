import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JwksValidator } from "./types.js";

type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

export class JwksValidatorImpl implements JwksValidator {
	private cache = new Map<string, RemoteJWKSet>();
	private readonly maxCacheSize: number;

	constructor(opts?: { maxCacheSize?: number }) {
		this.maxCacheSize = opts?.maxCacheSize ?? 100;
	}

	async verify(
		jwt: string,
		expectedIssuer: string,
		expectedAudience: string,
	): Promise<Record<string, unknown>> {
		const jwks = this.getOrCreateJwks(expectedIssuer);
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

	private getOrCreateJwks(issuer: string): RemoteJWKSet {
		let jwks = this.cache.get(issuer);
		if (!jwks) {
			if (this.cache.size >= this.maxCacheSize) {
				const firstKey = this.cache.keys().next().value;
				if (firstKey) {
					this.cache.delete(firstKey);
				}
			}
			const jwksUrl = new URL("/.well-known/jwks.json", issuer);
			jwks = createRemoteJWKSet(jwksUrl);
			this.cache.set(issuer, jwks);
		}
		return jwks;
	}

	dispose(): void {
		this.cache.clear();
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
