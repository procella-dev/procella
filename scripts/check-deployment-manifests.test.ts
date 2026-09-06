import { describe, expect, test } from "bun:test";
import {
	checkDeploymentManifests,
	checkManifest,
	checkProxyConfig,
	DEPLOYMENT_MANIFESTS,
	type DeploymentManifest,
} from "./check-deployment-manifests.ts";

const COMPOSE: DeploymentManifest = {
	path: "docker-compose.yml",
	migrationPatterns: [/--migrate/, /service_completed_successfully/],
};
const RENDER: DeploymentManifest = {
	path: "render.yaml",
	migrationPatterns: [/preDeployCommand:.*--migrate/],
	render: true,
};
const VALID_ENV = `
PROCELLA_DATABASE_URL: postgres://db
PROCELLA_AUTH_MODE: dev
PROCELLA_ENCRYPTION_KEY: secret
PROCELLA_TICKET_SIGNING_KEY: secret
`;

describe("check-deployment-manifests", () => {
	test("every supported manifest satisfies the startup contract", async () => {
		expect(await checkDeploymentManifests()).toEqual([]);
		expect(DEPLOYMENT_MANIFESTS.map(({ path }) => path)).toEqual([
			"docker-compose.yml",
			"docker-compose.coolify.yml",
			"render.yaml",
			"railway.toml",
			"fly.toml",
			".env.example",
		]);
	});

	test("comments cannot satisfy bootstrap variables or migration gates", () => {
		const text = `${VALID_ENV.replace("PROCELLA_TICKET_SIGNING_KEY", "OTHER")}
# PROCELLA_TICKET_SIGNING_KEY: secret
# service_completed_successfully
--migrate
`;
		expect(checkManifest(COMPOSE, text)).toEqual([
			"docker-compose.yml: missing PROCELLA_TICKET_SIGNING_KEY",
			"docker-compose.yml: missing migration startup gate (service_completed_successfully)",
		]);
	});

	test("documented PaaS secrets require an explicit provisioning command", () => {
		const manifest: DeploymentManifest = {
			path: "fly.toml",
			provisioningCommand: "fly secrets set",
		};
		const text = `
[env]
PROCELLA_AUTH_MODE = "dev"
# fly secrets set PROCELLA_DATABASE_URL=<url>
# PROCELLA_ENCRYPTION_KEY=<key>
# fly secrets set PROCELLA_TICKET_SIGNING_KEY=<key>
`;
		expect(checkManifest(manifest, text)).toEqual(["fly.toml: missing PROCELLA_ENCRYPTION_KEY"]);
	});

	test("every binary bootstrap service receives the full config", () => {
		const manifest: DeploymentManifest = {
			path: "coolify.yml",
			bootstrapServices: ["procella", "migrate"],
		};
		const text = `
services:
  procella:
    environment: &env
      PROCELLA_DATABASE_URL: postgres://db
      PROCELLA_AUTH_MODE: dev
      PROCELLA_ENCRYPTION_KEY: secret
      PROCELLA_TICKET_SIGNING_KEY: secret
  migrate:
    environment:
      PROCELLA_DATABASE_URL: postgres://db
`;
		expect(checkManifest(manifest, text)).toEqual([
			"coolify.yml -> migrate: missing PROCELLA_AUTH_MODE",
			"coolify.yml -> migrate: missing PROCELLA_ENCRYPTION_KEY",
			"coolify.yml -> migrate: missing PROCELLA_TICKET_SIGNING_KEY",
		]);
	});

	test("Render rejects grouped sync:false secrets", () => {
		const text = `${VALID_ENV}
preDeployCommand: "/procella --migrate"
envVarGroups:
  - name: secrets
    envVars:
      - key: PROCELLA_TICKET_SIGNING_KEY
        sync: false
`;
		expect(checkManifest(RENDER, text)).toEqual([
			"render.yaml: PROCELLA_TICKET_SIGNING_KEY uses unsupported sync: false in envVarGroups.secrets",
		]);
	});

	test("the sample signing key cannot pass runtime validation", () => {
		const manifest: DeploymentManifest = { path: ".env.example", sampleSecrets: true };
		const text = VALID_ENV.replace(
			"PROCELLA_TICKET_SIGNING_KEY: secret",
			"PROCELLA_TICKET_SIGNING_KEY: CHANGE_ME_GENERATE_RANDOM_64_HEX",
		).replaceAll(": ", "=");
		expect(checkManifest(manifest, text)).toContain(
			".env.example: ticket-signing placeholder passes runtime validation",
		);
	});

	test("the cluster proxy retains every public server route", () => {
		expect(checkProxyConfig("/api/* /trpc/* /healthz /github/setup")).toEqual([]);
		expect(checkProxyConfig("/api/* /trpc/* /healthz\n# /github/setup")).toEqual([
			"Caddyfile: missing server route /github/setup",
		]);
	});
});
