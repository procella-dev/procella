import signUpOrInFlowJson from "./flows/sign-up-or-in.json" with { type: "json" };
import stylesJson from "./flows/styles.json" with { type: "json" };

const managementKey = new sst.Secret("DescopeManagementKey");

const signUpOrInFlow = JSON.stringify(signUpOrInFlowJson);
const stylesData = JSON.stringify(stylesJson);

const provider = new descope.Provider("DescopeProvider", {
	managementKey: managementKey.value,
});

const userJwtTemplate = JSON.stringify({
	roles: "{{user.roles}}",
	tenants: "{{user.tenants}}",
});

const accessKeyJwtTemplate = JSON.stringify({
	roles: "{{accesskey.roles}}",
	tenants: "{{accesskey.tenants}}",
});

const project = new descope.Project(
	"Strata",
	{
		// ── Project-level settings ──────────────────────────────────────────────
		projectSettings: {
			// Reference the JWT templates defined below by name.
			userJwtTemplate: "Strata User",
			accessKeyJwtTemplate: "Strata Access Key",
		},

		// ── JWT templates ────────────────────────────────────────────────────────
		// These are the templates that Descope uses when issuing JWTs.
		// The Strata auth service (packages/auth) requires:
		//   - `dct` claim (auto-set by autoTenantClaim) for tenant detection
		//   - `roles` claim for RBAC (viewer / member / admin)
		jwtTemplates: {
			userTemplates: [
				{
					name: "Strata User",
					description: "Default JWT template for Strata users — includes tenant and role claims",
					template: userJwtTemplate,
					authSchema: "default",
					autoTenantClaim: true,
				},
			],
			accessKeyTemplates: [
				{
					name: "Strata Access Key",
					description: "Default JWT template for Strata access keys — includes tenant and role claims",
					template: accessKeyJwtTemplate,
					authSchema: "default",
					autoTenantClaim: true,
				},
			],
		},

		// ── Authorization ────────────────────────────────────────────────────────
		// Roles and permissions that map to Strata's RBAC model.
		// The auth service in packages/auth validates these role names in JWT claims.
		authorization: {
			roles: [
				{
					name: "Tenant Admin",
					description: "Descope built-in role — grants access to UserManagement and TenantProfile management widgets",
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

		// ── Authentication methods ───────────────────────────────────────────────
		authentication: {
			password: {
				minLength: 12,
				lowercase: true,
				uppercase: true,
				number: true,
				nonAlphanumeric: true,
				// Lock account after 10 consecutive failures; temp-lock after 5 within a window.
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

		// ── Flows ────────────────────────────────────────────────────────────────
		// Custom sign-up-or-in flow with auto tenant provisioning.
		// The UI uses flowId="sign-up-or-in" (hardcoded in Login.tsx).
		flows: {
			"sign-up-or-in": { data: signUpOrInFlow },
		},

		styles: { data: stylesData },
	},
	{ provider },
);

export const descopeProjectId = project.id;
