import { beforeEach, describe, expect, mock, test } from "bun:test";

const callOrder: string[] = [];

const mockCreateWithId = mock(async (_tenantId: string, _tenantName: string) => ({ ok: true }));
const mockCreateTestUser = mock(
  async (
    _loginId: string,
    _options: { userTenants: Array<{ tenantId: string; roleNames: string[] }> },
  ) => ({ ok: true, data: { userId: "user-123" } }),
);
const mockCreateAccessKey = mock(
  async (
    _name: string,
    _expireTime: number,
    _roles: undefined,
    _tenants: Array<{ tenantId: string; roleNames: string[] }>,
    _userId: string,
    _customClaims: { procellaLogin: string },
  ) => ({
    ok: true,
    data: { key: { id: "key-123" }, cleartext: "token-abc" },
  }),
);
const mockDeleteAllTestUsers = mock(async () => {
  callOrder.push("deleteAllTestUsers");
});

const mockDescopeClient = mock(() => ({
  management: {
    tenant: {
      createWithId: (...args: Parameters<typeof mockCreateWithId>) => {
        callOrder.push("createWithId");
        return mockCreateWithId(...args);
      },
    },
    user: {
      createTestUser: (...args: Parameters<typeof mockCreateTestUser>) => {
        callOrder.push("createTestUser");
        return mockCreateTestUser(...args);
      },
      deleteAllTestUsers: (...args: Parameters<typeof mockDeleteAllTestUsers>) =>
        mockDeleteAllTestUsers(...args),
    },
    accessKey: {
      create: (...args: Parameters<typeof mockCreateAccessKey>) => {
        callOrder.push("createAccessKey");
        return mockCreateAccessKey(...args);
      },
    },
  },
}));

mock.module("@descope/node-sdk", () => ({
  default: mockDescopeClient,
}));

const { cleanupAuth, setupAuth } = await import("./setup-preview-auth");

describe("setup-preview-auth", () => {
  beforeEach(() => {
    callOrder.length = 0;
    mockDescopeClient.mockClear();
    mockCreateWithId.mockReset();
    mockCreateTestUser.mockReset();
    mockCreateAccessKey.mockReset();
    mockDeleteAllTestUsers.mockReset();

    mockCreateWithId.mockResolvedValue({ ok: true });
    mockCreateTestUser.mockResolvedValue({ ok: true, data: { userId: "user-123" } });
    mockCreateAccessKey.mockResolvedValue({
      ok: true,
      data: { key: { id: "key-123" }, cleartext: "token-abc" },
    });
    mockDeleteAllTestUsers.mockImplementation(async () => {
      callOrder.push("deleteAllTestUsers");
    });
  });

  test("setupAuth creates tenant, user, and access key with expected params", async () => {
    const result = await setupAuth("project-id", "mgmt-key");

    expect(mockDescopeClient).toHaveBeenCalledWith({
      projectId: "project-id",
      managementKey: "mgmt-key",
    });
    expect(mockCreateWithId).toHaveBeenCalledWith("ci-bench", "CI Bench");
    expect(mockCreateTestUser).toHaveBeenCalledWith("ci-bot@bench.local", {
      userTenants: [{ tenantId: "ci-bench", roleNames: ["admin"] }],
    });
    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.stringContaining("ci-bench-key-"),
      0,
      undefined,
      [{ tenantId: "ci-bench", roleNames: ["admin"] }],
      "user-123",
      { procellaLogin: "ci-bot@bench.local" },
    );
    expect(result).toEqual({ token: "token-abc", keyId: "key-123" });
  });

  test("setupAuth uses lowercase admin role", async () => {
    await setupAuth("project-id", "mgmt-key");

    expect(mockCreateTestUser).toHaveBeenCalledWith("ci-bot@bench.local", {
      userTenants: [{ tenantId: "ci-bench", roleNames: ["admin"] }],
    });
    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.any(String),
      0,
      undefined,
      [{ tenantId: "ci-bench", roleNames: ["admin"] }],
      "user-123",
      { procellaLogin: "ci-bot@bench.local" },
    );
  });

  test("setupAuth deletes test users before provisioning", async () => {
    await setupAuth("project-id", "mgmt-key");

    expect(callOrder[0]).toBe("deleteAllTestUsers");
  });

  test("setupAuth tolerates tenant already exists errors", async () => {
    mockCreateWithId.mockRejectedValueOnce(new Error("tenant already exists"));

    const result = await setupAuth("project-id", "mgmt-key");
    expect(result.token).toBe("token-abc");
    expect(result.keyId).toBe("key-123");
  });

  test("setupAuth throws on non-idempotent tenant create errors", async () => {
    mockCreateWithId.mockRejectedValueOnce(new Error("permission denied"));

    return expect(setupAuth("project-id", "mgmt-key")).rejects.toThrow("permission denied");
  });

  test("cleanupAuth deletes all test users", async () => {
    await cleanupAuth("project-id", "mgmt-key");

    expect(mockDescopeClient).toHaveBeenCalledWith({
      projectId: "project-id",
      managementKey: "mgmt-key",
    });
    expect(mockDeleteAllTestUsers).toHaveBeenCalledTimes(1);
    expect(mockCreateWithId).toHaveBeenCalledTimes(0);
    expect(mockCreateTestUser).toHaveBeenCalledTimes(0);
    expect(mockCreateAccessKey).toHaveBeenCalledTimes(0);
  });
});
