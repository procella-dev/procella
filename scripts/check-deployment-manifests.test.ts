import { describe, expect, test } from "bun:test";
import {
	checkDeploymentManifests,
	checkManifest,
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

	test("missing bootstrap variables and migration gates fail", () => {
		const missingTicketKey = VALID_ENV.replace("PROCELLA_TICKET_SIGNING_KEY", "OTHER");
		expect(checkManifest(COMPOSE, `${missingTicketKey}\n--migrate`)).toEqual([
			"docker-compose.yml: missing PROCELLA_TICKET_SIGNING_KEY",
			"docker-compose.yml: missing migration startup gate (service_completed_successfully)",
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
});
