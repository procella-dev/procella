import type { Caller, WorkloadIdentity } from "@procella/types";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod/v4";

const SUBSCRIPTION_TICKET_ISSUER = "procella";
const SUBSCRIPTION_TICKET_AUDIENCE = "procella:trpc-subscription";
export const SUBSCRIPTION_TICKET_TTL_SECONDS = 60;

const workloadIdentitySchema = z.object({
	provider: z.string(),
	issuer: z.string(),
	subject: z.string(),
	repository: z.string().optional(),
	repositoryId: z.string().optional(),
	repositoryOwner: z.string().optional(),
	repositoryOwnerId: z.string().optional(),
	workflowRef: z.string().optional(),
	jobWorkflowRef: z.string().optional(),
	environment: z.string().optional(),
	ref: z.string().optional(),
	refProtected: z.boolean().optional(),
	runId: z.string().optional(),
	runAttempt: z.string().optional(),
	actor: z.string().optional(),
	actorId: z.string().optional(),
	jti: z.string().optional(),
});

const subscriptionTicketClaimsSchema = z.object({
	tenantId: z.string().min(1),
	orgSlug: z.string().min(1),
	userId: z.string(),
	login: z.string().min(1),
	roles: z.array(z.enum(["admin", "member", "viewer"])).min(1),
	principalType: z.enum(["user", "token", "workload"]),
	workload: workloadIdentitySchema.optional(),
});

type SubscriptionTicketClaims = z.infer<typeof subscriptionTicketClaimsSchema>;

export interface SubscriptionTicketService {
	issueTicket(caller: Caller): Promise<string>;
	verifyTicket(ticket: string): Promise<Caller>;
}

export function createSubscriptionTicketService(signingKey: string): SubscriptionTicketService {
	const secret = new TextEncoder().encode(signingKey);

	return {
		async issueTicket(caller) {
			const claims = callerToClaims(caller);
			return await new SignJWT(claims)
				.setProtectedHeader({ alg: "HS256", typ: "JWT" })
				.setIssuer(SUBSCRIPTION_TICKET_ISSUER)
				.setAudience(SUBSCRIPTION_TICKET_AUDIENCE)
				.setIssuedAt()
				.setExpirationTime(`${SUBSCRIPTION_TICKET_TTL_SECONDS}s`)
				.sign(secret);
		},
		async verifyTicket(ticket) {
			const { payload } = await jwtVerify(ticket, secret, {
				algorithms: ["HS256"],
				audience: SUBSCRIPTION_TICKET_AUDIENCE,
				issuer: SUBSCRIPTION_TICKET_ISSUER,
			});

			return claimsToCaller(subscriptionTicketClaimsSchema.parse(payload));
		},
	};
}

function callerToClaims(caller: Caller): SubscriptionTicketClaims {
	return {
		tenantId: caller.tenantId,
		orgSlug: caller.orgSlug,
		userId: caller.userId,
		login: caller.login,
		roles: [...caller.roles],
		principalType: caller.principalType,
		...(caller.workload ? { workload: normalizeWorkload(caller.workload) } : {}),
	};
}

function claimsToCaller(claims: SubscriptionTicketClaims): Caller {
	return {
		tenantId: claims.tenantId,
		orgSlug: claims.orgSlug,
		userId: claims.userId,
		login: claims.login,
		roles: claims.roles,
		principalType: claims.principalType,
		...(claims.workload ? { workload: claims.workload } : {}),
	};
}

function normalizeWorkload(workload: WorkloadIdentity): WorkloadIdentity {
	return {
		provider: workload.provider,
		issuer: workload.issuer,
		subject: workload.subject,
		...(workload.repository ? { repository: workload.repository } : {}),
		...(workload.repositoryId ? { repositoryId: workload.repositoryId } : {}),
		...(workload.repositoryOwner ? { repositoryOwner: workload.repositoryOwner } : {}),
		...(workload.repositoryOwnerId ? { repositoryOwnerId: workload.repositoryOwnerId } : {}),
		...(workload.workflowRef ? { workflowRef: workload.workflowRef } : {}),
		...(workload.jobWorkflowRef ? { jobWorkflowRef: workload.jobWorkflowRef } : {}),
		...(workload.environment ? { environment: workload.environment } : {}),
		...(workload.ref ? { ref: workload.ref } : {}),
		...(typeof workload.refProtected === "boolean" ? { refProtected: workload.refProtected } : {}),
		...(workload.runId ? { runId: workload.runId } : {}),
		...(workload.runAttempt ? { runAttempt: workload.runAttempt } : {}),
		...(workload.actor ? { actor: workload.actor } : {}),
		...(workload.actorId ? { actorId: workload.actorId } : {}),
		...(workload.jti ? { jti: workload.jti } : {}),
	};
}
