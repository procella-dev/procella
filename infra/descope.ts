import * as descope from "@descope/pulumi-descope";
import signUpOrInFlowJson from "./flows/sign-up-or-in.json" with { type: "json" };
import stylesJson from "./flows/styles.json" with { type: "json" };
import { descopeManagementKey } from "./secrets";

const signUpOrInFlow = JSON.stringify(signUpOrInFlowJson);
const stylesData = JSON.stringify(stylesJson);

const isProd = $app.stage === "production";
const rootDomain = isProd ? "procella.cloud" : `${$app.stage}.procella.cloud`;

// ── Custom auth domain ──────────────────────────────────────────────────────
// Descope serves auth from auth.<rootDomain> so it can set the session/refresh
// cookies as HttpOnly first-party cookies scoped to <rootDomain>. The browser
// then sends them implicitly to app.<rootDomain> (same registrable domain) and
// the server validates the session JWT straight from the DS cookie.
//
// This CNAME is more specific than the router's `*.<rootDomain>` CloudFront
// alias record, so DNS resolves auth.* to Descope, not to our distribution.
// Descope provisions the TLS certificate automatically once the CNAME is live.
const authDomain = `auth.${rootDomain}`;
export const authBaseUrl = `https://${authDomain}`;

const zone = aws.route53.getZoneOutput({ name: "procella.cloud" });
new aws.route53.Record("DescopeAuthCname", {
	zoneId: zone.zoneId,
	name: authDomain,
	type: "CNAME",
	ttl: 300,
	records: ["cname.descope.com"],
});

// ── Provider ────────────────────────────────────────────────────────────────
const provider = new descope.Provider("DescopeProvider", {
	managementKey: descopeManagementKey.value,
});

// ── JWT Templates ───────────────────────────────────────────────────────
// Descope template placeholders use {{...}} syntax. The Pulumi/Terraform
// provider requires the template to be valid JSON, so placeholders must be
// quoted as string values. Descope's backend interprets them at runtime and
// emits the actual arrays/objects in the JWT claims.
// packages/auth expects tenants as Record<string, { roles: string[] }> and
// roles as string[]. `tenant_name` carries the human-friendly tenant name.
const userJwtTemplate = JSON.stringify({
	roles: "{{user.roles}}",
	tenants: "{{user.tenants}}",
	tenant_name: "{{tenant.name}}",
});

const accessKeyJwtTemplate = JSON.stringify({
	roles: "{{accesskey.roles}}",
	tenants: "{{accesskey.tenants}}",
	tenant_name: "{{tenant.name}}",
});

// ── Project ─────────────────────────────────────────────────────────────────
const project = new descope.Project(
	"Procella",
	{
		name: `procella-${$app.stage}`,

		// ── Project-level settings ──────────────────────────────────────────
		projectSettings: {
			userJwtTemplate: "Procella User",
			accessKeyJwtTemplate: "Procella Access Key",
			// Tokens are delivered as HttpOnly cookies (never exposed to JS) via the
			// custom auth domain. Cookie domain is the stage apex so app.<rootDomain>
			// receives them implicitly on same-origin requests; the server falls back
			// to the DS cookie when no Authorization header is present (packages/auth).
			// `lax` (not `strict`) so cookies survive the OAuth redirect back from the IdP.
			// The Descope provider requires appUrl with customDomain, and customDomain
			// must be a subdomain of the appUrl domain — use the stage apex (which
			// also serves the UI, see infra/site.ts) so auth.<rootDomain> qualifies.
			appUrl: `https://${rootDomain}`,
			customDomain: authDomain,
			sessionTokenResponseMethod: "cookies",
			refreshTokenResponseMethod: "cookies",
			sessionTokenCookieDomain: rootDomain,
			refreshTokenCookieDomain: rootDomain,
			sessionTokenCookiePolicy: "lax",
			refreshTokenCookiePolicy: "lax",
		},

		// ── JWT templates ────────────────────────────────────────────────────
		// The Procella auth service (packages/auth) requires:
		//   - `dct` claim (auto-set by autoTenantClaim) for tenant detection
		//   - `roles` claim for RBAC (viewer / member / admin)
		//   - `tenant_name` claim for human-friendly org name (slugified at runtime)
		jwtTemplates: {
			userTemplates: [
				{
					name: "Procella User",
					description: "Default JWT template for Procella users — includes tenant and role claims",
					template: userJwtTemplate,
					authSchema: "default",
					autoTenantClaim: true,
				},
			],
			accessKeyTemplates: [
				{
					name: "Procella Access Key",
					description:
						"Default JWT template for Procella access keys — includes tenant and role claims",
					template: accessKeyJwtTemplate,
					authSchema: "default",
					autoTenantClaim: true,
				},
			],
		},

		// ── Authorization ────────────────────────────────────────────────────
		// Roles and permissions that map to Procella's RBAC model.
		authorization: {
			roles: [
				{
					name: "Tenant Admin",
					description:
						"Descope built-in role — grants access to UserManagement and TenantProfile management widgets",
					permissions: ["User Admin", "SSO Admin", "Impersonate"],
				},
				{
					name: "admin",
					description: "Full access — can create stacks, run updates, and manage org members",
					permissions: ["stacks:write", "stacks:delete", "members:manage"],
				},
				{
					name: "member",
					description: "Can create and run stack updates",
					permissions: ["stacks:write"],
				},
				{
					name: "viewer",
					description: "Read-only access to stacks and update history",
					permissions: [],
				},
			],
			permissions: [
				{ name: "stacks:write", description: "Create and update stacks" },
				{ name: "stacks:delete", description: "Delete stacks" },
				{ name: "members:manage", description: "Manage org members and roles" },
			],
		},

		// ── Authentication methods ───────────────────────────────────────────
		authentication: {
			password: {
				minLength: 12,
				lowercase: true,
				uppercase: true,
				number: true,
				nonAlphanumeric: true,
				lock: true,
				lockAttempts: 10,
				temporaryLock: true,
				temporaryLockAttempts: 5,
				temporaryLockDuration: "15 minutes",
			},
			otp: {},
			magicLink: {},
			totp: {},
			passkeys: {},
			oauth: {},
		},

		// ── Flows ────────────────────────────────────────────────────────────
		// Custom sign-up-or-in flow with auto tenant provisioning.
		// The UI uses flowId="sign-up-or-in" (hardcoded in Login.tsx).
		flows: {
			"sign-up-or-in": { data: signUpOrInFlow },
		},

		styles: { data: stylesData },
	},
	{ provider },
);

// ── Outputs ─────────────────────────────────────────────────────────────────
const projectId = project.id;

export { project, projectId };
