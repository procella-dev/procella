/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "procella",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				"@pulumi/random": "4.16.7",
				// Descope Pulumi provider — manages Descope project config as code.
				// Credentials: set DESCOPE_MANAGEMENT_KEY env var.
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		const descope = await import("./infra/descope");

		// ========================================================================
		// SECRETS
		// ========================================================================

		const dbPassword = new random.RandomPassword("ProcellaDbPassword", {
			length: 32,
			special: true,
			overrideSpecial: "_%",
		}).result;

		const encryptionKeyHex = new random.RandomBytes("ProcellaEncryptionKey", {
			length: 32,
		}).hex;

		// Store encryption key in Secrets Manager so ECS can inject it via ssm (ARN-based).
		const encryptionKeySecret = new aws.secretsmanager.Secret("ProcellaEncryptionKeySecret", {
			description: "Procella AES-256-GCM encryption key",
		});
		new aws.secretsmanager.SecretVersion("ProcellaEncryptionKeyVersion", {
			secretId: encryptionKeySecret.id,
			secretString: encryptionKeyHex,
		});

		// Descope management key for ECS container injection (Secrets Manager ARN).
		// The infra/descope.ts module manages its own sst.Secret("DescopeManagementKey")
		// for the Descope provider; this is the Secrets Manager secret the ECS task reads.
		const descopeKeySecret = new aws.secretsmanager.Secret("ProcellaDescopeKey", {
			description: "Descope Management Key for Procella",
		});
		const descopeKeyValue = process.env.DESCOPE_MANAGEMENT_KEY ?? "";
		if (!descopeKeyValue && $app.stage === "production") {
			throw new Error(
				"DESCOPE_MANAGEMENT_KEY is required for production. Set it in your environment or CI secrets.",
			);
		}
		new aws.secretsmanager.SecretVersion("ProcellaDescopeKeyVersion", {
			secretId: descopeKeySecret.id,
			secretString: descopeKeyValue || "placeholder-key",
		});

		// ========================================================================
		// NETWORKING
		// ========================================================================

		const vpc = new sst.aws.Vpc("ProcellaVpc", {
			nat: "managed",
		});

		// ========================================================================
		// STORAGE
		// ========================================================================

		const staticAssets = new sst.aws.Bucket("ProcellaStatic", {
			versioning: true,
			access: "cloudfront",
		});

		const checkpointBlobs = new sst.aws.Bucket("ProcellaCheckpoints", {
			versioning: true,
		});

		const postgresStorage = new sst.aws.Efs("PostgresStorage", {
			vpc,
			performance: "general-purpose",
			throughput: "bursting",
			transform: {
				accessPoint: {
					posixUser: {
						uid: 999, // postgres user
						gid: 999, // postgres group
					},
					rootDirectory: {
						path: "/postgresql",
						creationInfo: {
							ownerUid: 999,
							ownerGid: 999,
							permissions: "755",
						},
					},
				},
			},
		});

		// ========================================================================
		// ECS CLUSTER
		// ========================================================================

		// Deploy containers in private subnets (with NAT) and load balancers in
		// public subnets — matches the original architecture.
		const cluster = new sst.aws.Cluster("ProcellaCluster", {
			vpc: {
				id: vpc.id,
				securityGroups: vpc.securityGroups,
				containerSubnets: vpc.privateSubnets,
				loadBalancerSubnets: vpc.publicSubnets,
				cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
				cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
			},
		});

		// ========================================================================
		// POSTGRESQL SERVICE (ECS Fargate + EFS)
		// ========================================================================

		// Cloud Map service discovery gives this service a DNS name that the app
		// service uses to connect (via `db.service` output).
		const db = new sst.aws.Service("ProcellaDb", {
			cluster,
			architecture: "arm64",
			cpu: "0.25 vCPU",
			memory: "0.5 GB",
			image: "postgres:17-alpine",
			environment: {
				POSTGRES_USER: "procella",
				POSTGRES_DB: "procella",
				POSTGRES_PASSWORD: dbPassword,
			},
			volumes: [
				{
					efs: postgresStorage,
					path: "/var/lib/postgresql/data",
				},
			],
			health: {
				command: ["CMD-SHELL", "pg_isready -U procella"],
				interval: "5 seconds",
				timeout: "5 seconds",
				retries: 10,
				startPeriod: "30 seconds",
			},
			scaling: {
				min: 1,
				max: 1,
			},
			serviceRegistry: {
				port: 5432,
			},
			transform: {
				service: {
					deploymentCircuitBreaker: {
						enable: false,
						rollback: false,
					},
				},
			},
		});

		// ========================================================================
		// PROCELLA APP SERVICE (ECS Fargate + ALB)
		// ========================================================================

		const app = new sst.aws.Service("ProcellaApp", {
			cluster,
			architecture: "arm64",
			cpu: "0.5 vCPU",
			memory: "1 GB",
			image: {
				context: ".",
				dockerfile: "Dockerfile",
			},
			link: [checkpointBlobs],
			environment: {
				PROCELLA_LISTEN_ADDR: ":9090",
				PROCELLA_AUTH_MODE: "descope",
				PROCELLA_DESCOPE_PROJECT_ID: descope.descopeProjectId,
				PROCELLA_BLOB_BACKEND: "s3",
				PROCELLA_BLOB_S3_BUCKET: checkpointBlobs.name,
				PROCELLA_BLOB_S3_REGION: aws.getRegionOutput().name,
				PROCELLA_CORS_ORIGINS: $interpolate`https://${$app.stage === "production" ? "procella" : $app.stage}.procella.dev`,
				PROCELLA_DATABASE_URL: dbPassword.apply(
					(pw) => $interpolate`postgresql://procella:${encodeURIComponent(pw)}@${db.service}:5432/procella`,
				),
			},
			ssm: {
				PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeKeySecret.arn,
				PROCELLA_ENCRYPTION_KEY: encryptionKeySecret.arn,
			},
			loadBalancer: {
				rules: [
					{ listen: "80/http", forward: "9090/http" },
				],
				health: {
					"9090/http": {
						path: "/healthz",
						interval: "5 seconds",
						timeout: "3 seconds",
						healthyThreshold: 2,
						unhealthyThreshold: 2,
					},
				},
			},
			scaling: {
				min: 2,
				max: 10,
				cpuUtilization: 70,
			},
		});

		// ========================================================================
		// CLOUDFRONT CDN (Static Assets)
		// ========================================================================

		const oac = new aws.cloudfront.OriginAccessControl("ProcellaOac", {
			originAccessControlOriginType: "s3",
			signingBehavior: "always",
			signingProtocol: "sigv4",
		});

		const cdn = new sst.aws.Cdn("ProcellaCdn", {
			origins: [
				{
					domainName: staticAssets.nodes.bucket.bucketRegionalDomainName,
					originId: "S3",
					originAccessControlId: oac.id,
				},
			],
			defaultCacheBehavior: {
				targetOriginId: "S3",
				viewerProtocolPolicy: "allow-all",
				allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
				cachedMethods: ["GET", "HEAD"],
				forwardedValues: {
					queryString: false,
					cookies: { forward: "none" },
				},
				compress: true,
				minTtl: 0,
				defaultTtl: 3600,
				maxTtl: 86400,
			},
			orderedCacheBehaviors: [
				{
					pathPattern: "*.{js,css,png,jpg,jpeg,gif,svg,woff,woff2}",
					targetOriginId: "S3",
					viewerProtocolPolicy: "allow-all",
					allowedMethods: ["GET", "HEAD", "OPTIONS"],
					cachedMethods: ["GET", "HEAD"],
					forwardedValues: {
						queryString: false,
						cookies: { forward: "none" },
					},
					compress: true,
					minTtl: 0,
					defaultTtl: 31536000,
					maxTtl: 31536000,
				},
			],
			transform: {
				distribution: {
					priceClass: "PriceClass_100",
				},
			},
		});

		// ========================================================================
		// STACK OUTPUTS
		// ========================================================================

		return {
			// Descope
			DescopeProjectId: descope.descopeProjectId,

			// Networking
			VpcId: vpc.id,
			PublicSubnets: vpc.publicSubnets,
			PrivateSubnets: vpc.privateSubnets,

			// ECS
			ClusterId: cluster.id,
			AppUrl: app.url,
			DbServiceEndpoint: db.service,

			// S3
			StaticAssetsBucket: staticAssets.name,
			CheckpointBlobsBucket: checkpointBlobs.name,

			// CloudFront
			CloudFrontUrl: cdn.url,
			CloudFrontDistributionId: cdn.nodes.distribution.id,

			// Database
			EfsId: postgresStorage.id,
		};
	},
});
