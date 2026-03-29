import { webApi } from "./web-api";

const isProd = $app.stage === "production";
const stage = $app.stage;

// AWS-managed CloudFront cache policy: CachingDisabled
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
// AWS-managed origin request policy: AllViewerExceptHostHeader
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

export const site = new sst.aws.StaticSite("ProcellaSite", {
	path: "apps/ui",
	build: {
		command: "bun run build",
		output: "dist",
	},
	domain: isProd
		? {
				name: "app.procella.cloud",
				redirects: ["www.procella.cloud", "procella.cloud"],
			}
		: `app.${stage}.procella.cloud`,
	environment: {
		VITE_API_URL: "",
		VITE_APP_URL: isProd ? "https://app.procella.cloud" : `https://app.${stage}.procella.cloud`,
	},
	transform: {
		cdn: (args) => {
			// SPA routing: serve index.html for 403/404
			args.customErrorResponses = [
				{ errorCode: 403, responsePagePath: "/index.html", responseCode: 200 },
				{ errorCode: 404, responsePagePath: "/index.html", responseCode: 200 },
			];

			// Add Web Lambda as a second origin for tRPC + auth routes
			args.origins = $resolve([args.origins, webApi.url]).apply(([origins, lambdaUrl]) => {
				const lambdaDomain = new URL(lambdaUrl).hostname;
				return [
					...(origins as object[]),
					{
						domainName: lambdaDomain,
						originId: "web-lambda",
						customOriginConfig: {
							httpPort: 80,
							httpsPort: 443,
							originProtocolPolicy: "https-only",
							originSslProtocols: ["TLSv1.2"],
						},
					},
				];
			});

			// Route /trpc/* and /api/auth/* to Web Lambda (before default /* → S3)
			args.orderedCacheBehaviors = [
				{
					pathPattern: "/trpc/*",
					targetOriginId: "web-lambda",
					viewerProtocolPolicy: "redirect-to-https",
					allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
					cachedMethods: ["GET", "HEAD"],
					compress: true,
					cachePolicyId: CACHING_DISABLED,
					originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
				},
				{
					pathPattern: "/api/auth/*",
					targetOriginId: "web-lambda",
					viewerProtocolPolicy: "redirect-to-https",
					allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
					cachedMethods: ["GET", "HEAD"],
					compress: true,
					cachePolicyId: CACHING_DISABLED,
					originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
				},
			];
		},
	},
});
