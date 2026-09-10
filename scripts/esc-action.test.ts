import { describe, expect, test } from "bun:test";

/** Contract tests for the repository-hosted `actions/esc` JavaScript action. */

const ACTION_PATH = new URL("../actions/esc/action.yml", import.meta.url).pathname;
const BUNDLE_PATH = new URL("../actions/esc/dist/index.js", import.meta.url).pathname;

const PROCELLA_CLOUD_URL = "https://api.procella.cloud";
const PINNED_UPSTREAM_SHA = "57e332b6dfb0d7edcf6cb813ee9a98b9665f12c2";
const PINNED_UPSTREAM_TAG = "v3.2.1";
const PINNED_BUNDLE_SHA256 = "4210722867f4100e213fc202f94ff5aaf2d6180bdb7a51b9c7c1ff4526c779b3";

/** Input surface of `pulumi/esc-action` at {@link PINNED_UPSTREAM_SHA}. */
const UPSTREAM_INPUT_DEFAULTS: Record<string, string | null> = {
	version: "",
	environment: "",
	keys: "",
	"cloud-url": "",
	"export-environment-variables": null,
	"oidc-auth": "",
	"oidc-organization": "",
	"oidc-requested-token-type": "",
	"oidc-scope": "",
	"oidc-token-expiration": "",
};

interface InputSpec {
	description?: string;
	required?: boolean;
	default?: string;
}

interface ActionMetadata {
	name: string;
	description: string;
	inputs: Record<string, InputSpec>;
	runs: { using: string; main: string };
}

const source = await Bun.file(ACTION_PATH).text();
const action = Bun.YAML.parse(source) as ActionMetadata;

describe("actions/esc upstream mirror", () => {
	test("pins the official release and its byte-for-byte runtime bundle", async () => {
		expect(source).toContain(
			`Mirrored from pulumi/esc-action ${PINNED_UPSTREAM_TAG} (${PINNED_UPSTREAM_SHA}).`,
		);
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(await Bun.file(BUNDLE_PATH).arrayBuffer());
		expect(hasher.digest("hex")).toBe(PINNED_BUNDLE_SHA256);
		expect(action.runs).toEqual({ using: "node24", main: "dist/index.js" });
	});

	test("exposes the complete pinned upstream input surface", () => {
		expect(Object.keys(action.inputs)).toEqual(Object.keys(UPSTREAM_INPUT_DEFAULTS));
		expect(
			Object.entries(action.inputs)
				.filter(([, spec]) => spec.required === true)
				.map(([name]) => name),
		).toEqual([]);
	});

	test("changes only the cloud-url default", () => {
		const diverging = Object.entries(UPSTREAM_INPUT_DEFAULTS)
			.filter(([name, defaultValue]) => (action.inputs[name]?.default ?? null) !== defaultValue)
			.map(([name]) => name);
		expect(diverging).toEqual(["cloud-url"]);
		expect(action.inputs["cloud-url"]?.default).toBe(PROCELLA_CLOUD_URL);
	});
});
