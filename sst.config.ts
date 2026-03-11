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
				// Credentials: run `sst secret set DescopeManagementKey <your-key>`
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		const { createDescopeProject } = await import("./infra/descope");

		const isProd = $app.stage === "production";
		const domain = isProd ? "procella.dev" : `${$app.stage}.procella.dev`;
		const apiDomain = `api.${domain}`;
		const docsDomain = `docs.${domain}`;

		// ========================================================================
		// SECRETS
		// ========================================================================

		// Single source of truth for Descope management key — used by both the
		// Pulumi Descope provider (at deploy time) and ECS containers (at runtime).
		// Set via: `sst secret set DescopeManagementKey <your-key>`
		const descopeManagementKey = new sst.Secret("DescopeManagementKey");
		const descope = createDescopeProject(descopeManagementKey);

		const dbPassword = new random.RandomPassword("ProcellaDbPassword", {
			length: 32,
			special: true,
			overrideSpecial: "_%",
		}).result;

		const encryptionKeyHex = new random.RandomBytes("ProcellaEncryptionKey", {
			length: 32,
		}).hex;

		// Store secrets in Secrets Manager so ECS can inject them via ssm (ARN-based).
		const encryptionKeySecret = new aws.secretsmanager.Secret("ProcellaEncryptionKeySecret", {
			description: "Procella AES-256-GCM encryption key",
		});
		new aws.secretsmanager.SecretVersion("ProcellaEncryptionKeyVersion", {
			secretId: encryptionKeySecret.id,
			secretString: encryptionKeyHex,
		});

		const descopeKeySecret = new aws.secretsmanager.Secret("ProcellaDescopeKey", {
			description: "Descope Management Key for Procella",
		});
		new aws.secretsmanager.SecretVersion("ProcellaDescopeKeyVersion", {
			secretId: descopeKeySecret.id,
			secretString: descopeManagementKey.value,
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
				PROCELLA_DESCOPE_PROJECT_ID: descope.projectId,
				PROCELLA_BLOB_BACKEND: "s3",
				PROCELLA_BLOB_S3_BUCKET: checkpointBlobs.name,
				PROCELLA_BLOB_S3_REGION: aws.getRegionOutput().name,
				PROCELLA_CORS_ORIGINS: $interpolate`https://${domain}`,
				PROCELLA_DATABASE_URL: dbPassword.apply(
					(pw) => $interpolate`postgresql://procella:${encodeURIComponent(pw)}@${db.service}:5432/procella`,
				),
			},
			ssm: {
				PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeKeySecret.arn,
				PROCELLA_ENCRYPTION_KEY: encryptionKeySecret.arn,
			},
			loadBalancer: {
				domain: { name: apiDomain, dns: sst.aws.dns() },
				rules: [
					{ listen: "80/http", forward: "9090/http" },
					{ listen: "443/https", forward: "9090/http" },
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

		const web = new sst.aws.StaticSite("ProcellaWeb", {
			path: "apps/ui",
			build: { command: "bun run build", output: "dist" },
			domain: { name: domain, dns: sst.aws.dns() },
			environment: {
				VITE_API_URL: `https://${apiDomain}`,
			},
		});

		const docs = new sst.aws.StaticSite("ProcellaDocs", {
			path: "apps/docs",
			build: { command: "bun run build", output: "dist" },
			domain: { name: docsDomain, dns: sst.aws.dns() },
		});

		// ========================================================================
		// STACK OUTPUTS
		// ========================================================================

		return {
			// Descope
			DescopeProjectId: descope.projectId,

			// Networking
			VpcId: vpc.id,
			PublicSubnets: vpc.publicSubnets,
			PrivateSubnets: vpc.privateSubnets,

			// ECS
			ClusterId: cluster.id,
			ApiUrl: app.url,
			WebUrl: web.url,
			DocsUrl: docs.url,
			DbServiceEndpoint: db.service,

			// S3
			CheckpointBlobsBucket: checkpointBlobs.name,

			// Database
			EfsId: postgresStorage.id,
		};
	},
});
