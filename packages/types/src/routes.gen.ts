// Auto-generated from pulumi/pulumi pkg/backend/httpstate/client/api_endpoints.go
// Pulumi SDK v3.227.0 — do not edit manually.
// Regenerate: bun run packages/types/tygo/generate-routes.ts

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export const PulumiRoutes = {
  getCapabilities: { method: "GET" as Method, path: "/api/capabilities" },
  getCurrentUser: { method: "GET" as Method, path: "/api/user" },
  listUserStacks: { method: "GET" as Method, path: "/api/user/stacks" },
  getDefaultOrg: { method: "GET" as Method, path: "/api/user/organizations/default" },
  listOrganizationStacks: { method: "GET" as Method, path: "/api/stacks/:org" },
  createStack: { method: "POST" as Method, path: "/api/stacks/:org" },
  deleteStack: { method: "DELETE" as Method, path: "/api/stacks/:org/:project/:stack" },
  getStack: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack" },
  exportStack: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/export" },
  importStack: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/import" },
  encryptValue: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/encrypt" },
  decryptValue: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/decrypt" },
  getStackLogs: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/logs" },
  getStackUpdates: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/updates" },
  getLatestStackUpdate: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/updates/latest" },
  getStackUpdate: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/updates/:version" },
  getUpdateContentsFiles: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/updates/:version/contents/files" },
  getUpdateContentsFilePath: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/updates/:version/contents/file/:path" },
  listTemplates: { method: "GET" as Method, path: "/api/orgs/:org/templates" },
  downloadTemplates: { method: "GET" as Method, path: "/api/orgs/:org/templates/download" },
  batchDecrypt: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/batch-decrypt" },
  batchEncrypt: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/batch-encrypt" },
  createDestroy: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/destroy" },
  createPreview: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/preview" },
  createUpdate: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/update" },
  getUpdateStatus: { method: "GET" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId" },
  startUpdate: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId" },
  patchCheckpoint: { method: "PATCH" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/checkpoint" },
  patchCheckpointDelta: { method: "PATCH" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/checkpointdelta" },
  patchCheckpointVerbatim: { method: "PATCH" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/checkpointverbatim" },
  completeUpdate: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/complete" },
  postEngineEvent: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/events" },
  postEngineEventBatch: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/events/batch" },
  renewLease: { method: "POST" as Method, path: "/api/stacks/:org/:project/:stack/:kind/:updateId/renew_lease" },
  publishPolicyPack: { method: "POST" as Method, path: "/api/orgs/:org/policypacks" },
  getSearchResources: { method: "GET" as Method, path: "/api/orgs/:org/search/resources" },
  getSearchResourcesParse: { method: "GET" as Method, path: "/api/orgs/:org/search/resources/parse" },
  publishPackage: { method: "POST" as Method, path: "/api/preview/registry/packages/:source/:publisher/:name/versions" },
  completePackagePublish: { method: "POST" as Method, path: "/api/preview/registry/packages/:source/:publisher/:name/versions/:version/complete" },
  deletePackageVersion: { method: "DELETE" as Method, path: "/api/registry/packages/:source/:publisher/:name/versions/:version" },
  publishTemplate: { method: "POST" as Method, path: "/api/registry/templates/:source/:publisher/:name/versions" },
  completeTemplatePublish: { method: "POST" as Method, path: "/api/registry/templates/:source/:publisher/:name/versions/:version/complete" },
} as const;

export type PulumiRouteName = keyof typeof PulumiRoutes;
