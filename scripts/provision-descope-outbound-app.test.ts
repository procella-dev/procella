import { describe, expect, mock, test } from "bun:test";
import {
	createOutboundAppProvisioner,
	DESCOPE_OUTBOUND_CALLBACK_URL,
	GITHUB_AUTHORIZATION_URL,
	GITHUB_OUTBOUND_SCOPES,
	GITHUB_TOKEN_URL,
	type OutboundApplicationSdk,
} from "./provision-descope-outbound-app";

const environment = {
	PROCELLA_DESCOPE_PROJECT_ID: "P2test",
	PROCELLA_DESCOPE_MANAGEMENT_KEY: "management-key",
	PROCELLA_GITHUB_APP_CLIENT_ID: "Iv1.client-id",
	PROCELLA_GITHUB_APP_CLIENT_SECRET: "client-secret",
};

const EXPECTED_APPLICATION = {
	id: "procella-github",
	name: "Procella GitHub",
	description:
		"Vaults the GitHub user token Procella uses to verify account administration before binding a GitHub App installation to a tenant.",
	clientId: "Iv1.client-id",
	clientSecret: "client-secret",
	authorizationUrl: "https://github.com/login/oauth/authorize",
	tokenUrl: "https://github.com/login/oauth/access_token",
	defaultRedirectUrl: "https://api.descope.com/v1/outbound/oauth/callback",
	defaultScopes: ["read:user", "read:org"],
	pkce: false,
};

/** Mock responses are shaped per test, so overrides stay untyped at the seam. */
type SdkOverrides = Partial<Record<keyof OutboundApplicationSdk, unknown>>;

function sdk(overrides: SdkOverrides = {}) {
	return {
		loadApplication: mock(async () => ({ ok: false, code: 404 })),
		createApplication: mock(async () => ({ ok: true, data: { id: "procella-github" } })),
		updateApplication: mock(async () => ({ ok: true, data: { id: "procella-github" } })),
		...overrides,
	} as unknown as OutboundApplicationSdk;
}

function provisioner(
	client: OutboundApplicationSdk,
	env: Record<string, string | undefined> = environment,
) {
	const createSdk = mock(() => client);
	const write = mock(() => undefined);
	return { run: createOutboundAppProvisioner({ environment: env, createSdk, write }), createSdk };
}

describe("provision-descope-outbound-app", () => {
	test("declares the GitHub endpoints, Descope callback, and least-privilege scopes", () => {
		expect(GITHUB_AUTHORIZATION_URL).toBe("https://github.com/login/oauth/authorize");
		expect(GITHUB_TOKEN_URL).toBe("https://github.com/login/oauth/access_token");
		expect(DESCOPE_OUTBOUND_CALLBACK_URL).toBe(
			"https://api.descope.com/v1/outbound/oauth/callback",
		);
		expect([...GITHUB_OUTBOUND_SCOPES]).toEqual(["read:user", "read:org"]);
	});

	test("creates the application when Descope reports it missing", async () => {
		const client = sdk();
		const { run, createSdk } = provisioner(client);

		await run();

		expect(createSdk).toHaveBeenCalledWith("P2test", "management-key");
		expect(client.createApplication).toHaveBeenCalledWith(EXPECTED_APPLICATION);
		expect(client.updateApplication).not.toHaveBeenCalled();
	});

	test("updates an existing application in place, preserving unmanaged fields", async () => {
		const client = sdk({
			loadApplication: mock(async () => ({
				ok: true,
				data: { id: "procella-github", name: "stale", logo: "https://logo.example/x.png" },
			})),
		});
		const { run } = provisioner(client);

		await run();

		expect(client.updateApplication).toHaveBeenCalledWith({
			...EXPECTED_APPLICATION,
			logo: "https://logo.example/x.png",
		});
		expect(client.createApplication).not.toHaveBeenCalled();
	});

	test("is idempotent across repeated runs", async () => {
		let stored: Record<string, unknown> | null = null;
		const client = sdk({
			loadApplication: mock(async () =>
				stored ? { ok: true, data: stored } : { ok: false, code: 404 },
			),
			createApplication: mock(async (application: Record<string, unknown>) => {
				stored = application;
				return { ok: true, data: application };
			}),
			updateApplication: mock(async (application: Record<string, unknown>) => {
				stored = application;
				return { ok: true, data: application };
			}),
		});
		const { run } = provisioner(client);

		await run();
		await run();

		expect(client.createApplication).toHaveBeenCalledTimes(1);
		expect(client.updateApplication).toHaveBeenCalledTimes(1);
		expect(stored).toMatchObject(EXPECTED_APPLICATION);
	});

	test("fails on load, create, and update errors instead of reporting success", async () => {
		const failures: SdkOverrides[] = [
			{ loadApplication: mock(async () => ({ ok: false, code: 500 })) },
			{ createApplication: mock(async () => ({ ok: false, code: 400 })) },
			{
				loadApplication: mock(async () => ({ ok: true, data: { id: "procella-github" } })),
				updateApplication: mock(async () => ({ ok: false, code: 403 })),
			},
		];

		for (const override of failures) {
			const { run } = provisioner(sdk(override));
			await expect(run()).rejects.toThrow(/Descope outbound application request failed/);
		}
	});

	test("requires every deploy-time credential", async () => {
		for (const missing of Object.keys(environment)) {
			const { run } = provisioner(sdk(), { ...environment, [missing]: "" });
			await expect(run()).rejects.toThrow(`${missing} is required`);
		}
	});

	test("rejects a malformed outbound app id override", async () => {
		const { run } = provisioner(sdk(), {
			...environment,
			PROCELLA_GITHUB_OUTBOUND_APP_ID: "Procella GitHub",
		});

		await expect(run()).rejects.toThrow(/must be a lowercase slug/);
	});
});
