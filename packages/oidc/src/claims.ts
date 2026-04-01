export const OidcClaims = {
	principalType: "procellaPrincipalType",
	workloadProvider: "procellaWorkloadProvider",
	workloadSub: "procellaWorkloadSub",
	workloadRepo: "procellaWorkloadRepo",
	workloadRepoId: "procellaWorkloadRepoId",
	workloadRepoOwner: "procellaWorkloadRepoOwner",
	workloadRepoOwnerId: "procellaWorkloadRepoOwnerId",
	workloadWorkflowRef: "procellaWorkloadWorkflowRef",
	workloadEnvironment: "procellaWorkloadEnvironment",
	workloadRef: "procellaWorkloadRef",
	workloadRunId: "procellaWorkloadRunId",
	triggerActor: "procellaTriggerActor",
	triggerActorId: "procellaTriggerActorId",
	workloadJti: "procellaWorkloadJti",
} as const;

export const GRANT_TYPE_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const SUBJECT_TOKEN_TYPE_ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token";
export const REQUESTED_TOKEN_TYPE_ORG = "urn:pulumi:token-type:access_token:organization";
export const REQUESTED_TOKEN_TYPE_TEAM = "urn:pulumi:token-type:access_token:team";
export const REQUESTED_TOKEN_TYPE_PERSONAL = "urn:pulumi:token-type:access_token:personal";
export const AUDIENCE_PREFIX = "urn:pulumi:org:";
export const DEFAULT_EXCHANGE_EXPIRATION = 7200;
