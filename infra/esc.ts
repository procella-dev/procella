import { vpc } from "./database";

// ---------------------------------------------------------------------------
// ESC Evaluator Lambda — Go binary that embeds github.com/pulumi/esc
//
// Receives the YAML definition, pre-resolved imports, and encryption key in
// the invoke payload. Does NOT need: DB, S3 blob, or Procella runtime config.
// DOES need: STS for OIDC role-assumption (fn::open::aws-login), Secrets
// Manager + SSM for fn::open::aws-secrets / aws-parameter-store providers
// (procella/* prefix only). The CLI API function invokes this via
// @aws-sdk/client-lambda (sync invoke). SST `link` on the CLI API
// auto-grants lambda:InvokeFunction permission.
// ---------------------------------------------------------------------------
export const escEvaluator = new sst.aws.Function("ProcellaEscEvaluator", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/esc-eval",
	handler: "bootstrap",
	timeout: "60 seconds",
	memory: "512 MB",
	vpc,
	permissions: [
		{
			actions: ["sts:AssumeRoleWithWebIdentity"],
			resources: ["*"],
		},
		{
			actions: ["secretsmanager:GetSecretValue"],
			resources: ["arn:aws:secretsmanager:*:*:secret:procella/*"],
		},
		{
			actions: ["ssm:GetParameter"],
			resources: ["arn:aws:ssm:*:*:parameter/procella/*"],
		},
	],
});
