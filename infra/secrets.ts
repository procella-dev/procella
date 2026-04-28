export const encryptionKey = new sst.Secret("ProcellaEncryptionKey");
export const devAuthToken = new sst.Secret("ProcellaDevAuthToken");
export const descopeManagementKey = new sst.Secret("ProcellaDescopeManagementKey");
export const otelEndpoint = new sst.Secret("ProcellaOtelEndpoint");
export const otelHeaders = new sst.Secret("ProcellaOtelHeaders");
export const ticketSigningKey = new sst.Secret("ProcellaTicketSigningKey");

// allSecrets contains only secrets that every Lambda function needs.
// ticketSigningKey is API-only (CliApi + WebApi); link it explicitly per-function.
// cronSecret is intentionally NOT declared here — the AWS deploy uses a dedicated
// gc Lambda (gc-bootstrap.ts) that calls GCWorker.runOnce() directly, so the
// HTTP /cron/gc route in createApp() is never served from this infra. The route
// remains in the codebase for Vercel/Render deploys that drive cron over HTTP.
export const allSecrets = [
	encryptionKey,
	devAuthToken,
	descopeManagementKey,
	otelEndpoint,
	otelHeaders,
];
