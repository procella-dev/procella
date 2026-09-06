import { BadRequestError } from "@procella/types";
import {
	assertBoundedJson,
	MAX_FEATURE_COUNT,
	MAX_JSON_DEPTH,
	MAX_STRING_LENGTH,
	SUPPORTED_DEPLOYMENT_SCHEMA_VERSION,
	validateImportedDeployment,
} from "@procella/updates";
import { z } from "zod";

export { MAX_FEATURE_COUNT, MAX_JSON_DEPTH, MAX_STRING_LENGTH };
export const MAX_EVENT_BATCH_SIZE = 1000;
export const MAX_BATCH_CRYPT_ITEMS = 1000;
export const MAX_LEASE_DURATION_SECONDS = 300;

export const BoundedString = (max: number) => z.string().max(max);
export const BoundedJSON = z.unknown();

function withJsonBounds<T extends z.ZodTypeAny>(schema: T): T {
	return schema.superRefine((value, ctx) => {
		try {
			assertBoundedJson(value);
		} catch (error) {
			if (error instanceof BadRequestError) {
				ctx.addIssue({ code: "custom", message: error.message });
				return;
			}
			throw error;
		}
	}) as T;
}

/**
 * Procella advertises `deployment-schema-version` 3, so a compliant CLI downgrades to v3 and
 * drops `features` before sending. Anything else would be accepted here and then silently
 * re-exported as v3 with the feature data lost, so it is rejected at the wire boundary.
 */
const DeploymentSchemaVersion = z
	.number()
	.int()
	.nonnegative()
	.max(
		SUPPORTED_DEPLOYMENT_SCHEMA_VERSION,
		`Unsupported deployment schema version: Procella supports up to version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
	);

const FeatureListSchema = z
	.array(BoundedString(MAX_STRING_LENGTH))
	.max(MAX_FEATURE_COUNT)
	.max(
		0,
		`Unsupported deployment features: Procella supports up to deployment schema version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
	);

const JournalEntrySchema = z
	.object({
		version: z.number().int().nonnegative(),
		kind: z.number().int().nonnegative(),
		operationID: z.number().int().nonnegative(),
		sequenceID: z.number().int().nonnegative(),
		removeOld: z.number().int().nullable().optional(),
		removeNew: z.number().int().nullable().optional(),
		state: BoundedJSON.optional(),
		operation: BoundedJSON.optional(),
		secretsProvider: BoundedJSON.optional(),
		pendingReplacementOld: z.number().int().nullable().optional(),
		pendingReplacementNew: z.number().int().nullable().optional(),
		deleteOld: z.number().int().nullable().optional(),
		deleteNew: z.number().int().nullable().optional(),
		isRefresh: z.boolean().optional(),
		newSnapshot: BoundedJSON.optional(),
		elideWrite: z.boolean().optional(),
	})
	.strict();

const SummaryEventSchema = z
	.object({
		maybeCorrupt: z.boolean().optional(),
		durationSeconds: z.number().int().nonnegative().optional(),
		resourceChanges: z.record(z.string(), z.number().int().nonnegative()).optional(),
		PolicyPacks: z.record(z.string(), z.string()).optional(),
		isPreview: z.boolean().optional(),
		result: z.string().optional(),
	})
	.passthrough();

const EngineEventSchema = z
	.object({
		sequence: z.number().int().nonnegative(),
		timestamp: z.number().int().nonnegative(),
		summaryEvent: SummaryEventSchema.optional(),
	})
	.passthrough();

export const EngineEventBatchSchema = withJsonBounds(
	z
		.object({
			events: z.array(EngineEventSchema).max(MAX_EVENT_BATCH_SIZE),
		})
		.strict(),
);

export const PatchUpdateCheckpointRequestSchema = withJsonBounds(
	z
		.object({
			isInvalid: z.boolean().default(false),
			version: DeploymentSchemaVersion,
			deployment: BoundedJSON,
			features: FeatureListSchema.optional(),
		})
		.strict(),
);

export const PatchUpdateVerbatimCheckpointRequestSchema = withJsonBounds(
	z
		.object({
			version: DeploymentSchemaVersion,
			untypedDeployment: BoundedJSON,
			sequenceNumber: z.number().int().nonnegative(),
		})
		.strict(),
);

export const PatchUpdateCheckpointDeltaRequestSchema = withJsonBounds(
	z
		.object({
			version: DeploymentSchemaVersion,
			// Required: the delta is only safe to apply if the client states the expected result.
			checkpointHash: z
				.string()
				.regex(/^[0-9a-fA-F]{64}$/, "checkpointHash must be a 64-character SHA-256 hex digest"),
			sequenceNumber: z.number().int().nonnegative(),
			deploymentDelta: z.array(BoundedJSON),
		})
		.strict(),
);

export const JournalEntriesSchema = withJsonBounds(
	z
		.object({
			entries: z.array(JournalEntrySchema).optional(),
		})
		.strict(),
);

export const UntypedDeploymentSchema = z.unknown().transform((value, ctx) => {
	try {
		return validateImportedDeployment(value);
	} catch (error) {
		if (error instanceof BadRequestError) {
			ctx.addIssue({ code: "custom", message: error.message });
			return z.NEVER;
		}
		throw error;
	}
});

export const RenewUpdateLeaseRequestSchema = withJsonBounds(
	z
		.object({
			token: BoundedString(MAX_STRING_LENGTH),
			duration: z.number().int().positive().max(MAX_LEASE_DURATION_SECONDS).default(300),
		})
		.strict(),
);

export const EncryptValueRequestSchema = withJsonBounds(
	z
		.object({
			plaintext: z.string().max(MAX_STRING_LENGTH),
		})
		.strict(),
);

export const DecryptValueRequestSchema = withJsonBounds(
	z
		.object({
			ciphertext: z.string().max(MAX_STRING_LENGTH + 32),
		})
		.strict(),
);

export const BatchEncryptRequestSchema = withJsonBounds(
	z
		.object({
			plaintexts: z.array(z.string().max(MAX_STRING_LENGTH)).max(MAX_BATCH_CRYPT_ITEMS),
		})
		.strict(),
);

export const BatchDecryptRequestSchema = withJsonBounds(
	z
		.object({
			ciphertexts: z.array(z.string().max(MAX_STRING_LENGTH + 32)).max(MAX_BATCH_CRYPT_ITEMS),
		})
		.strict(),
);
