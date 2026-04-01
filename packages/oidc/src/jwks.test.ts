import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { JwksValidationError, JwksValidatorImpl } from "./jwks.js";

type PublicJwk = JsonWebKey & {
	kid: string;
	alg: string;
	use: string;
};

let privateKey: CryptoKey;
let publicJwk: PublicJwk;
let mockServer: ReturnType<typeof Bun.serve>;
let issuerUrl: string;

beforeAll(async () => {
	const keyPair = await generateKeyPair("RS256");
	privateKey = keyPair.privateKey;
	publicJwk = {
		...(await exportJWK(keyPair.publicKey)),
		kid: "test-kid-1",
		alg: "RS256",
		use: "sig",
	};

	mockServer = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/.well-known/jwks.json") {
				return new Response(JSON.stringify({ keys: [publicJwk] }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	issuerUrl = `http://localhost:${mockServer.port}`;
});

afterAll(() => {
	mockServer?.stop();
});

async function signJwt(
	claims: Record<string, unknown>,
	opts?: { expiresIn?: string; issuer?: string; audience?: string },
): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
		.setIssuedAt()
		.setExpirationTime(opts?.expiresIn ?? "5m")
		.setIssuer(opts?.issuer ?? issuerUrl)
		.setAudience(opts?.audience ?? "test-audience")
		.setSubject("test-subject")
		.sign(privateKey);
}

function getCacheSize(validator: JwksValidatorImpl): number {
	const withCache = validator as unknown as { cache: Map<string, unknown> };
	return withCache.cache.size;
}

describe("JwksValidatorImpl", () => {
	test("valid JWT with correct issuer and audience returns claims", async () => {
		const validator = new JwksValidatorImpl();
		const token = await signJwt({ custom: "value" });

		const claims = await validator.verify(token, issuerUrl, "test-audience");

		expect(claims.custom).toBe("value");
		expect(claims.sub).toBe("test-subject");
	});

	test("wrong issuer throws claim_validation_failed", async () => {
		const validator = new JwksValidatorImpl();
		const token = await signJwt({ foo: "bar" }, { issuer: `${issuerUrl}/unexpected-issuer` });

		try {
			await validator.verify(token, issuerUrl, "test-audience");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(JwksValidationError);
			const validationErr = err as JwksValidationError;
			expect(validationErr.code).toBe("claim_validation_failed");
		}
	});

	test("wrong audience throws JwksValidationError", async () => {
		const validator = new JwksValidatorImpl();
		const token = await signJwt({ foo: "bar" });

		await expect(validator.verify(token, issuerUrl, "wrong-audience")).rejects.toBeInstanceOf(
			JwksValidationError,
		);
	});

	test("expired JWT throws token_expired", async () => {
		const validator = new JwksValidatorImpl();
		const token = await signJwt({ foo: "bar" }, { expiresIn: "-1s" });

		try {
			await validator.verify(token, issuerUrl, "test-audience");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(JwksValidationError);
			const validationErr = err as JwksValidationError;
			expect(validationErr.code).toBe("token_expired");
		}
	});

	test("JWT signed with wrong key throws signature or key error", async () => {
		const validator = new JwksValidatorImpl();
		const wrongPair = await generateKeyPair("RS256");
		const token = await new SignJWT({ foo: "bar" })
			.setProtectedHeader({ alg: "RS256", kid: "wrong-kid" })
			.setIssuedAt()
			.setExpirationTime("5m")
			.setIssuer(issuerUrl)
			.setAudience("test-audience")
			.setSubject("test-subject")
			.sign(wrongPair.privateKey);

		try {
			await validator.verify(token, issuerUrl, "test-audience");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(JwksValidationError);
			const validationErr = err as JwksValidationError;
			expect(["signature_invalid", "no_matching_key"]).toContain(validationErr.code);
		}
	});

	test("malformed JWT string throws error", async () => {
		const validator = new JwksValidatorImpl();
		await expect(validator.verify("not-a-jwt", issuerUrl, "test-audience")).rejects.toBeInstanceOf(
			Error,
		);
	});

	test("multiple issuers are cached independently", async () => {
		const validator = new JwksValidatorImpl();
		const token1 = await signJwt({ source: "issuer-1" });

		const secondPair = await generateKeyPair("RS256");
		const secondPublicJwk: PublicJwk = {
			...(await exportJWK(secondPair.publicKey)),
			kid: "test-kid-2",
			alg: "RS256",
			use: "sig",
		};

		const secondServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/.well-known/jwks.json") {
					return new Response(JSON.stringify({ keys: [secondPublicJwk] }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const issuer2 = `http://localhost:${secondServer.port}`;
		const token2 = await new SignJWT({ source: "issuer-2" })
			.setProtectedHeader({ alg: "RS256", kid: "test-kid-2" })
			.setIssuedAt()
			.setExpirationTime("5m")
			.setIssuer(issuer2)
			.setAudience("test-audience")
			.setSubject("test-subject")
			.sign(secondPair.privateKey);

		try {
			const claims1 = await validator.verify(token1, issuerUrl, "test-audience");
			const claims2 = await validator.verify(token2, issuer2, "test-audience");

			expect(claims1.source).toBe("issuer-1");
			expect(claims2.source).toBe("issuer-2");
			expect(getCacheSize(validator)).toBe(2);
		} finally {
			secondServer.stop();
		}
	});

	test("dispose clears cache", async () => {
		const validator = new JwksValidatorImpl();
		const token = await signJwt({ foo: "bar" });

		await validator.verify(token, issuerUrl, "test-audience");
		expect(getCacheSize(validator)).toBe(1);

		validator.dispose();
		expect(getCacheSize(validator)).toBe(0);
	});
});
