import { vpc } from "./database";

// ---------------------------------------------------------------------------
// ESC Evaluator Lambda — Go binary that embeds github.com/pulumi/esc
//
// Self-contained: receives everything in the invoke payload (YAML definition,
// pre-resolved imports, encryption key). No DB, blob, or secret access needed.
// The CLI API function invokes this via @aws-sdk/client-lambda (sync invoke).
// SST `link` on the CLI API auto-grants lambda:InvokeFunction permission.
// ---------------------------------------------------------------------------
export const escEvaluator = new sst.aws.Function("ProcellaEscEvaluator", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/esc-eval",
	handler: "bootstrap",
	timeout: "60 seconds",
	memory: "512 MB",
	vpc,
});
