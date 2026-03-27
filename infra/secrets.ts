export const encryptionKey = new sst.Secret("ProcellaEncryptionKey");
export const devAuthToken = new sst.Secret("ProcellaDevAuthToken");
export const descopeProjectId = new sst.Secret("ProcellaDescopeProjectId");
export const descopeManagementKey = new sst.Secret("ProcellaDescopeManagementKey");

export const allSecrets = [encryptionKey, devAuthToken, descopeProjectId, descopeManagementKey];
