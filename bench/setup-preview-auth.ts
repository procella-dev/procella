import { appendFile } from "node:fs/promises";
import DescopeClient from "@descope/node-sdk";

const TENANT_ID = "ci-bench";
const TENANT_NAME = "CI Bench";
const LOGIN_ID = "ci-bot@bench.local";
const ADMIN_ROLE = "admin";

interface DescopeError {
  errorMessage?: string;
  errorDescription?: string;
}

interface DescopeResponse<T> {
  ok?: boolean;
  data?: T;
  error?: DescopeError;
}

function createClient(projectId: string, managementKey: string) {
  return DescopeClient({ projectId, managementKey });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getResponseErrorMessage(error?: DescopeError, fallback = "Descope request failed"): string {
  return error?.errorMessage ?? error?.errorDescription ?? fallback;
}

function isAlreadyExistsMessage(message: string): boolean {
  return /already\s+exists?|exists?/i.test(message);
}

async function deleteAllTestUsers(client: ReturnType<typeof createClient>): Promise<void> {
  await client.management.user.deleteAllTestUsers();
}

async function ensureTenant(client: ReturnType<typeof createClient>): Promise<void> {
  try {
    const response = (await client.management.tenant.createWithId(TENANT_ID, TENANT_NAME)) as
      | DescopeResponse<unknown>
      | undefined;
    if (response?.ok === false) {
      const message = getResponseErrorMessage(response.error, "Failed creating tenant");
      if (!isAlreadyExistsMessage(message)) {
        throw new Error(message);
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (!isAlreadyExistsMessage(message)) {
      throw error;
    }
  }
}

export async function setupAuth(
  projectId: string,
  managementKey: string,
): Promise<{ token: string; keyId: string }> {
  const client = createClient(projectId, managementKey);

  await deleteAllTestUsers(client);
  await ensureTenant(client);

  const userResp = (await client.management.user.createTestUser(LOGIN_ID, {
    userTenants: [{ tenantId: TENANT_ID, roleNames: [ADMIN_ROLE] }],
  })) as DescopeResponse<{ userId?: string }>;

  if (userResp.ok === false || !userResp.data?.userId) {
    throw new Error(getResponseErrorMessage(userResp.error, "Failed to create test user"));
  }

  const keyResp = (await client.management.accessKey.create(
    `ci-bench-key-${Date.now()}`,
    0,
    undefined,
    [{ tenantId: TENANT_ID, roleNames: [ADMIN_ROLE] }],
    userResp.data.userId,
    { procellaLogin: LOGIN_ID },
  )) as DescopeResponse<{ cleartext?: string; key?: { id?: string } }>;

  const token = keyResp.data?.cleartext;
  const keyId = keyResp.data?.key?.id;
  if (keyResp.ok === false || !token || !keyId) {
    throw new Error(getResponseErrorMessage(keyResp.error, "Failed to create access key"));
  }

  return { token, keyId };
}

export async function cleanupAuth(projectId: string, managementKey: string): Promise<void> {
  const client = createClient(projectId, managementKey);
  await deleteAllTestUsers(client);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function writeTokenOutput(token: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    process.stdout.write(`${token}\n`);
    return;
  }
  await appendFile(outputPath, `bench_token=${token}\n`, "utf8");
}

async function main(): Promise<void> {
  const projectId = getRequiredEnv("DESCOPE_PROJECT_ID");
  const managementKey = getRequiredEnv("DESCOPE_MANAGEMENT_KEY");
  const cleanup = process.argv.includes("--cleanup");

  if (cleanup) {
    await cleanupAuth(projectId, managementKey);
    return;
  }

  const { token } = await setupAuth(projectId, managementKey);
  await writeTokenOutput(token);
}

if (import.meta.main) {
  await main();
}
