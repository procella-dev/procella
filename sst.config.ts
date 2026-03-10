/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "procella",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				// Descope Pulumi provider — manages Descope project config as code.
				// Credentials: set DESCOPE_MANAGEMENT_KEY env var or run:
				//   sst secret set DescopeManagementKey <your-key>
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		const descope = await import("./infra/descope");

		// ========================================================================
		// CONFIGURATION
		// ========================================================================

		const appName = "procella";
		const region = aws.config.region || "us-east-1";

		// Networking
		const vpcCidr = "10.0.0.0/16";
		const publicSubnet1Cidr = "10.0.1.0/24";
		const publicSubnet2Cidr = "10.0.2.0/24";
		const privateSubnet1Cidr = "10.0.10.0/24";
		const privateSubnet2Cidr = "10.0.11.0/24";

		// ECS
		const ecsTaskCpu = "512"; // 0.5 vCPU
		const ecsTaskMemory = "1024"; // 1 GB
		const ecsDesiredCount = 2;
		const ecsMinCount = 2;
		const ecsMaxCount = 10;

		// Database (PostgreSQL on ECS + EFS)
		const dbTaskCpu = "256"; // 0.25 vCPU
		const dbTaskMemory = "512"; // 512 MB
		const efsSize = 10; // 10 GB

		// S3
		const staticAssetsBucketName = `${appName}-static-${Date.now()}`;
		const checkpointBlobsBucketName = `${appName}-checkpoints-${Date.now()}`;

		const dbPassword = process.env.PROCELLA_DB_PASSWORD;
		if (!dbPassword) throw new Error("PROCELLA_DB_PASSWORD is required");

		// ========================================================================
		// VPC + NETWORKING (Wave 1.1)
		// ========================================================================

		const vpc = new aws.ec2.Vpc(`${appName}-vpc`, {
			cidrBlock: vpcCidr,
			enableDnsHostnames: true,
			enableDnsSupport: true,
			tags: { Name: `${appName}-vpc` },
		});

		// Availability Zones
		const azs = await aws.getAvailabilityZones({ state: "available", region });

		// Public Subnets
		const publicSubnet1 = new aws.ec2.Subnet(`${appName}-public-subnet-1`, {
			vpcId: vpc.id,
			cidrBlock: publicSubnet1Cidr,
			availabilityZone: azs.names[0],
			mapPublicIpOnLaunch: true,
			tags: { Name: `${appName}-public-1` },
		});

		const publicSubnet2 = new aws.ec2.Subnet(`${appName}-public-subnet-2`, {
			vpcId: vpc.id,
			cidrBlock: publicSubnet2Cidr,
			availabilityZone: azs.names[1],
			mapPublicIpOnLaunch: true,
			tags: { Name: `${appName}-public-2` },
		});

		// Private Subnets
		const privateSubnet1 = new aws.ec2.Subnet(`${appName}-private-subnet-1`, {
			vpcId: vpc.id,
			cidrBlock: privateSubnet1Cidr,
			availabilityZone: azs.names[0],
			tags: { Name: `${appName}-private-1` },
		});

		const privateSubnet2 = new aws.ec2.Subnet(`${appName}-private-subnet-2`, {
			vpcId: vpc.id,
			cidrBlock: privateSubnet2Cidr,
			availabilityZone: azs.names[1],
			tags: { Name: `${appName}-private-2` },
		});

		// Internet Gateway
		const igw = new aws.ec2.InternetGateway(`${appName}-igw`, {
			vpcId: vpc.id,
			tags: { Name: `${appName}-igw` },
		});

		// Public Route Table
		const publicRt = new aws.ec2.RouteTable(`${appName}-public-rt`, {
			vpcId: vpc.id,
			routes: [
				{
					cidrBlock: "0.0.0.0/0",
					gatewayId: igw.id,
				},
			],
			tags: { Name: `${appName}-public-rt` },
		});

		new aws.ec2.RouteTableAssociation(`${appName}-public-rta-1`, {
			subnetId: publicSubnet1.id,
			routeTableId: publicRt.id,
		});

		new aws.ec2.RouteTableAssociation(`${appName}-public-rta-2`, {
			subnetId: publicSubnet2.id,
			routeTableId: publicRt.id,
		});

		// Elastic IP for NAT Gateway
		const natEip = new aws.ec2.Eip(`${appName}-nat-eip`, {
			vpc: true,
			tags: { Name: `${appName}-nat-eip` },
		});

		// NAT Gateway
		const natGw = new aws.ec2.NatGateway(`${appName}-nat-gw`, {
			allocationId: natEip.id,
			subnetId: publicSubnet1.id,
			tags: { Name: `${appName}-nat-gw` },
		});

		// Private Route Table
		const privateRt = new aws.ec2.RouteTable(`${appName}-private-rt`, {
			vpcId: vpc.id,
			routes: [
				{
					cidrBlock: "0.0.0.0/0",
					natGatewayId: natGw.id,
				},
			],
			tags: { Name: `${appName}-private-rt` },
		});

		new aws.ec2.RouteTableAssociation(`${appName}-private-rta-1`, {
			subnetId: privateSubnet1.id,
			routeTableId: privateRt.id,
		});

		new aws.ec2.RouteTableAssociation(`${appName}-private-rta-2`, {
			subnetId: privateSubnet2.id,
			routeTableId: privateRt.id,
		});

		// ========================================================================
		// SECURITY GROUPS (Wave 1.6 + Wave 2.2)
		// ========================================================================

		// ALB Security Group
		const albSg = new aws.ec2.SecurityGroup(`${appName}-alb-sg`, {
			vpcId: vpc.id,
			description: "Security group for ALB",
			ingress: [
				{
					protocol: "tcp",
					fromPort: 80,
					toPort: 80,
					cidrBlocks: ["0.0.0.0/0"],
				},
				{
					protocol: "tcp",
					fromPort: 443,
					toPort: 443,
					cidrBlocks: ["0.0.0.0/0"],
				},
			],
			egress: [
				{
					protocol: "-1",
					fromPort: 0,
					toPort: 0,
					cidrBlocks: ["0.0.0.0/0"],
				},
			],
			tags: { Name: `${appName}-alb-sg` },
		});

		// ECS Security Group
		const ecsSg = new aws.ec2.SecurityGroup(`${appName}-ecs-sg`, {
			vpcId: vpc.id,
			description: "Security group for ECS tasks",
			ingress: [
				{
					protocol: "tcp",
					fromPort: 9090,
					toPort: 9090,
					securityGroups: [albSg.id],
				},
			],
			egress: [
				{
					protocol: "-1",
					fromPort: 0,
					toPort: 0,
					cidrBlocks: ["0.0.0.0/0"],
				},
			],
			tags: { Name: `${appName}-ecs-sg` },
		});

		// PostgreSQL Security Group
		const dbSg = new aws.ec2.SecurityGroup(`${appName}-db-sg`, {
			vpcId: vpc.id,
			description: "Security group for PostgreSQL",
			ingress: [
				{
					protocol: "tcp",
					fromPort: 5432,
					toPort: 5432,
					securityGroups: [ecsSg.id],
				},
			],
			egress: [
				{
					protocol: "-1",
					fromPort: 0,
					toPort: 0,
					cidrBlocks: ["0.0.0.0/0"],
				},
			],
			tags: { Name: `${appName}-db-sg` },
		});

		// EFS Security Group
		const efsSg = new aws.ec2.SecurityGroup(`${appName}-efs-sg`, {
			vpcId: vpc.id,
			description: "Security group for EFS",
			ingress: [
				{
					protocol: "tcp",
					fromPort: 2049, // NFS
					toPort: 2049,
					securityGroups: [ecsSg.id],
				},
			],
			egress: [
				{
					protocol: "-1",
					fromPort: 0,
					toPort: 0,
					cidrBlocks: ["0.0.0.0/0"],
				},
			],
			tags: { Name: `${appName}-efs-sg` },
		});

		// ========================================================================
		// IAM ROLES (Wave 1.6)
		// ========================================================================

		const ecsTaskExecutionRole = new aws.iam.Role(`${appName}-task-execution-role`, {
			assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
				Service: "ecs-tasks.amazonaws.com",
			}),
		});

		new aws.iam.RolePolicyAttachment(`${appName}-task-execution-policy`, {
			role: ecsTaskExecutionRole,
			policyArn: aws.iam.ManagedPolicies.AmazonECSTaskExecutionRolePolicy,
		});

		// Allow ECR pull
		new aws.iam.RolePolicy(`${appName}-task-execution-ecr`, {
			role: ecsTaskExecutionRole,
			policy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["ecr:GetAuthorizationToken"],
						Resource: "*",
					},
					{
						Effect: "Allow",
						Action: [
							"ecr:BatchGetImage",
							"ecr:GetDownloadUrlForLayer",
						],
						Resource: "*",
					},
				],
			},
		});

		// Allow Secrets Manager read
		new aws.iam.RolePolicy(`${appName}-task-execution-secrets`, {
			role: ecsTaskExecutionRole,
			policy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["secretsmanager:GetSecretValue"],
						Resource: "*",
					},
				],
			},
		});

		// Task runtime role (for application code)
		const ecsTaskRole = new aws.iam.Role(`${appName}-task-role`, {
			assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
				Service: "ecs-tasks.amazonaws.com",
			}),
		});

		// Allow S3 access for checkpoint blobs
		new aws.iam.RolePolicy(`${appName}-task-s3`, {
			role: ecsTaskRole,
			policy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
						Resource: `arn:aws:s3:::${checkpointBlobsBucketName}/*`,
					},
					{
						Effect: "Allow",
						Action: ["s3:ListBucket"],
						Resource: `arn:aws:s3:::${checkpointBlobsBucketName}`,
					},
				],
			},
		});

		// ========================================================================
		// SECRETS MANAGER (Wave 1.8)
		// ========================================================================

		const descopeKeySecret = new aws.secretsmanager.Secret(`${appName}-descope-key`, {
			description: "Descope Management Key for Procella",
		});

		// Descope Management Key - fetched from environment (DESCOPE_MANAGEMENT_KEY) or use placeholder
		new aws.secretsmanager.SecretVersion(`${appName}-descope-key-version`, {
			secretId: descopeKeySecret.id,
			secretString: process.env.DESCOPE_MANAGEMENT_KEY || "placeholder-key",
		});

		// Generate encryption key (64 hex chars = 32 bytes for AES-256)
		const encryptionKeySecret = new aws.secretsmanager.Secret(`${appName}-encryption-key`, {
			description: "PROCELLA_ENCRYPTION_KEY for AES-256-GCM",
		});

		// Generate random 64-char hex string
		const encryptionKeyValue = Array.from({ length: 32 }, () =>
			Math.floor(Math.random() * 16).toString(16)
		)
			.join("")
			.repeat(2)
			.substring(0, 64);

		new aws.secretsmanager.SecretVersion(`${appName}-encryption-key-version`, {
			secretId: encryptionKeySecret.id,
			secretString: encryptionKeyValue,
		});

		// ========================================================================
		// S3 BUCKETS (Wave 1.5)
		// ========================================================================

		const staticAssetsBucket = new aws.s3.Bucket(`${appName}-static`, {
			bucket: staticAssetsBucketName,
			acl: "private",
			serverSideEncryptionConfiguration: {
				rule: {
					applyServerSideEncryptionByDefault: {
						sseAlgorithm: "AES256",
					},
				},
			},
			versioningConfiguration: {
				enabled: true,
			},
			tags: { Name: `${appName}-static` },
		});

		const checkpointBlobsBucket = new aws.s3.Bucket(`${appName}-checkpoints`, {
			bucket: checkpointBlobsBucketName,
			acl: "private",
			serverSideEncryptionConfiguration: {
				rule: {
					applyServerSideEncryptionByDefault: {
						sseAlgorithm: "AES256",
					},
				},
			},
			versioningConfiguration: {
				enabled: true,
			},
			tags: { Name: `${appName}-checkpoints` },
		});

		// ========================================================================
		// EFS (Wave 1.3)
		// ========================================================================

		const efs = new aws.efs.FileSystem(`${appName}-efs`, {
			performanceMode: "generalPurpose",
			throughputMode: "bursting",
			tags: { Name: `${appName}-efs` },
		});

		// EFS Mount Targets
		new aws.efs.MountTarget(`${appName}-efs-mount-1`, {
			fileSystemId: efs.id,
			subnetId: privateSubnet1.id,
			securityGroups: [efsSg.id],
		});

		new aws.efs.MountTarget(`${appName}-efs-mount-2`, {
			fileSystemId: efs.id,
			subnetId: privateSubnet2.id,
			securityGroups: [efsSg.id],
		});

		// ========================================================================
		// CLOUDWATCH LOGS (Wave 1.7)
		// ========================================================================

		const logGroup = new aws.cloudwatch.LogGroup(`${appName}-logs`, {
			name: `/ecs/${appName}`,
			retentionInDays: 7,
			tags: { Name: `${appName}-logs` },
		});

		const dbLogGroup = new aws.cloudwatch.LogGroup(`${appName}-db-logs`, {
			name: `/ecs/${appName}-db`,
			retentionInDays: 7,
			tags: { Name: `${appName}-db-logs` },
		});

		// ========================================================================
		// ECR REPOSITORY (for Docker images)
		// ========================================================================

		const ecrRepo = new aws.ecr.Repository(`${appName}-repo`, {
			name: appName,
			imageTagMutability: "MUTABLE",
			imageScanningConfiguration: {
				scanOnPush: false,
			},
			tags: { Name: `${appName}-ecr` },
		});

		// ========================================================================
		// ECS CLUSTER (Wave 1.2)
		// ========================================================================

		const ecsCluster = new aws.ecs.Cluster(`${appName}-cluster`, {
			name: `${appName}-cluster`,
			settings: [
				{
					name: "containerInsights",
					value: "enabled",
				},
			],
			tags: { Name: `${appName}-cluster` },
		});

		// ========================================================================
		// PROCELLA SERVER TASK DEFINITION (Wave 1.2)
		// ========================================================================

		const procellaServerTaskDef = new aws.ecs.TaskDefinition(`${appName}-task`, {
			family: `${appName}-task`,
			networkMode: "awsvpc",
			requiresCompatibilities: ["FARGATE"],
			cpu: ecsTaskCpu,
			memory: ecsTaskMemory,
			executionRoleArn: ecsTaskExecutionRole.arn,
			taskRoleArn: ecsTaskRole.arn,
			containerDefinitions: pulumi.all([
				descopeKeySecret.arn,
				encryptionKeySecret.arn,
				logGroup.name,
				ecrRepo.repositoryUrl,
			]).apply(([descopeKeyArn, encryptionKeyArn, logName, ecrUrl]) =>
				JSON.stringify([
					{
						name: "procella",
						image: `${ecrUrl}:latest`,
						portMappings: [
							{
								containerPort: 9090,
								hostPort: 9090,
								protocol: "tcp",
							},
						],
						environment: [
							{
								name: "PROCELLA_LISTEN_ADDR",
								value: ":9090",
							},
							{
								name: "PROCELLA_AUTH_MODE",
								value: "descope",
							},
							{
								name: "PROCELLA_DESCOPE_PROJECT_ID",
								value: descope.descopeProjectId,
							},
							{
								name: "PROCELLA_BLOB_BACKEND",
								value: "s3",
							},
							{
								name: "PROCELLA_BLOB_S3_BUCKET",
								value: checkpointBlobsBucketName,
							},
							{
								name: "PROCELLA_BLOB_S3_REGION",
								value: region,
							},
							{
								name: "PROCELLA_CORS_ORIGINS",
								value: `https://${$app.stage === "production" ? "procella" : $app.stage}.procella.dev`,
							},
						{
							name: "PROCELLA_DATABASE_URL",
							value: `postgresql://procella:${encodeURIComponent(dbPassword)}@procella-db.local:5432/procella`,
						},
						],
						secrets: [
							{
								name: "PROCELLA_DESCOPE_MANAGEMENT_KEY",
								valueFrom: descopeKeyArn,
							},
							{
								name: "PROCELLA_ENCRYPTION_KEY",
								valueFrom: encryptionKeyArn,
							},
						],
						logConfiguration: {
							logDriver: "awslogs",
							options: {
								"awslogs-group": logName,
								"awslogs-region": region,
								"awslogs-stream-prefix": "procella",
							},
						},
						healthCheck: {
							command: ["CMD-SHELL", "curl -sf http://localhost:9090/healthz || exit 1"],
							interval: 5,
							timeout: 3,
							retries: 10,
							startPeriod: 30,
						},
					},
				])
			),
			tags: { Name: `${appName}-task` },
		});

		// ========================================================================
		// POSTGRESQL TASK DEFINITION (Wave 1.3)
		// ========================================================================

		// Create access point for EFS (needed for persistent storage)
		const efsAccessPoint = new aws.efs.AccessPoint(`${appName}-db-ap`, {
			fileSystemId: efs.id,
			posixUserConfig: {
				uid: 999, // postgres user UID
				gid: 999, // postgres group GID
			},
			rootDirectory: {
				path: "/postgresql",
				creationInfo: {
					ownerUid: 999,
					ownerGid: 999,
					permissions: "755",
				},
			},
		});

		const dbTaskDef = new aws.ecs.TaskDefinition(`${appName}-db-task`, {
			family: `${appName}-db-task`,
			networkMode: "awsvpc",
			requiresCompatibilities: ["FARGATE"],
			cpu: dbTaskCpu,
			memory: dbTaskMemory,
			executionRoleArn: ecsTaskExecutionRole.arn,
			containerDefinitions: pulumi.all([dbLogGroup.name]).apply(([logName]) =>
				JSON.stringify([
					{
						name: "postgres",
						image: "postgres:17-alpine",
						portMappings: [
							{
								containerPort: 5432,
								hostPort: 5432,
								protocol: "tcp",
							},
						],
						environment: [
							{
								name: "POSTGRES_USER",
								value: "procella",
							},
							{
								name: "POSTGRES_DB",
								value: "procella",
							},
							{
								name: "POSTGRES_PASSWORD",
								value: dbPassword,
							},
						],
						mountPoints: [
							{
								sourceVolume: "postgresql-storage",
								containerPath: "/var/lib/postgresql/data",
								readOnly: false,
							},
						],
						logConfiguration: {
							logDriver: "awslogs",
							options: {
								"awslogs-group": logName,
								"awslogs-region": region,
								"awslogs-stream-prefix": "postgres",
							},
						},
						healthCheck: {
							command: ["CMD-SHELL", "pg_isready -U procella"],
							interval: 5,
							timeout: 5,
							retries: 10,
							startPeriod: 30,
						},
					},
				])
			),
			volumes: [
				{
					name: "postgresql-storage",
					efsVolumeConfiguration: {
						fileSystemId: efs.id,
						transitEncryption: "ENABLED",
						authorizationConfig: {
							accessPointId: efsAccessPoint.id,
						},
					},
				},
			],
			tags: { Name: `${appName}-db-task` },
		});

		// ========================================================================
		// APPLICATION LOAD BALANCER (Wave 1.4)
		// ========================================================================

		const alb = new aws.lb.LoadBalancer(`${appName}-alb`, {
			internal: false,
			loadBalancerType: "application",
			securityGroups: [albSg.id],
			subnets: [publicSubnet1.id, publicSubnet2.id],
			enableDeletionProtection: false,
			tags: { Name: `${appName}-alb` },
		});

		const targetGroup = new aws.lb.TargetGroup(`${appName}-tg`, {
			name: `${appName}-tg`,
			port: 9090,
			protocol: "HTTP",
			vpcId: vpc.id,
			targetType: "ip",
			healthCheck: {
				healthyThreshold: 2,
				unhealthyThreshold: 2,
				timeout: 3,
				interval: 5,
				path: "/healthz",
				matcher: "200",
			},
			deregistrationDelay: 30,
			tags: { Name: `${appName}-tg` },
		});

		const listener = new aws.lb.Listener(`${appName}-listener`, {
			loadBalancerArn: alb.arn,
			port: 80,
			protocol: "HTTP",
			defaultActions: [
				{
					type: "forward",
					targetGroupArn: targetGroup.arn,
				},
			],
		});

		// ========================================================================
		// ECS SERVICES (Wave 1.2 + 1.3)
		// ========================================================================

		// Procella Server Service
		const procellaService = new aws.ecs.Service(`${appName}-service`, {
			cluster: ecsCluster.arn,
			taskDefinition: procellaServerTaskDef.arn,
			desiredCount: ecsDesiredCount,
			launchType: "FARGATE",
			networkConfiguration: {
				subnets: [privateSubnet1.id, privateSubnet2.id],
				securityGroups: [ecsSg.id],
				assignPublicIp: false,
			},
			loadBalancers: [
				{
					targetGroupArn: targetGroup.arn,
					containerName: "procella",
					containerPort: 9090,
				},
			],
			deploymentConfiguration: {
				maximumPercent: 200,
				minimumHealthyPercent: 100,
			},
			tags: { Name: `${appName}-service` },
		}, { dependsOn: [listener] });

		// PostgreSQL Service
		const dbSvc = new aws.ecs.Service(`${appName}-db-service`, {
			cluster: ecsCluster.arn,
			taskDefinition: dbTaskDef.arn,
			desiredCount: 1,
			launchType: "FARGATE",
			networkConfiguration: {
				subnets: [privateSubnet1.id, privateSubnet2.id],
				securityGroups: [dbSg.id],
				assignPublicIp: false,
			},
			deploymentConfiguration: {
				maximumPercent: 100,
				minimumHealthyPercent: 100,
			},
			tags: { Name: `${appName}-db-service` },
		});

		// ========================================================================
		// AUTO SCALING (Wave 2.3)
		// ========================================================================

		const autoscalingTarget = new aws.appautoscaling.Target(`${appName}-asg-target`, {
			maxCapacity: ecsMaxCount,
			minCapacity: ecsMinCount,
			resourceId: pulumi.concat("service/", ecsCluster.name, "/", procellaService.name),
			scalableDimension: "ecs:service:DesiredCount",
			serviceNamespace: "ecs",
		});

		new aws.appautoscaling.Policy(`${appName}-asg-policy`, {
			policyType: "TargetTrackingScaling",
			resourceId: autoscalingTarget.resourceId,
			scalableDimension: autoscalingTarget.scalableDimension,
			serviceNamespace: autoscalingTarget.serviceNamespace,
			targetTrackingScalingPolicyConfiguration: {
				targetValue: 70,
				predefinedMetricSpecification: {
					predefinedMetricType: "ECSServiceAverageCPUUtilization",
				},
				scaleOutCooldown: 300,
				scaleInCooldown: 300,
			},
		});

		// ========================================================================
		// CLOUDFRONT (Wave 2.1)
		// ========================================================================

		// CloudFront Origin Access Identity
		const oai = new aws.cloudfront.OriginAccessIdentity(`${appName}-oai`, {
			comment: `OAI for ${appName} static assets`,
		});

		// Bucket policy for CloudFront
		new aws.s3.BucketPolicy(`${appName}-static-policy`, {
			bucket: staticAssetsBucket.id,
			policy: pulumi.all([staticAssetsBucket.arn, oai.iamArn]).apply(
				([bucketArn, oaiArn]) =>
					JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: {
									AWS: oaiArn,
								},
								Action: "s3:GetObject",
								Resource: `${bucketArn}/*`,
							},
						],
					})
			),
		});

		const cloudfront = new aws.cloudfront.Distribution(`${appName}-cdn`, {
			enabled: true,
			isIpv6Enabled: true,
			origins: [
				{
					domainName: staticAssetsBucket.bucketRegionalDomainName,
					originId: "S3",
					s3OriginConfig: {
						originAccessIdentity: oai.cloudfrontAccessIdentityPath,
					},
				},
			],
			defaultCacheBehavior: {
				allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
				cachedMethods: ["GET", "HEAD"],
				targetOriginId: "S3",
				forwardedValues: {
					queryString: false,
					cookies: {
						forward: "none",
					},
				},
				viewerProtocolPolicy: "allow-all",
				minTtl: 0,
				defaultTtl: 3600, // 1 hour for index.html
				maxTtl: 86400, // 1 day
				compress: true,
			},
			// Cache behavior for versioned assets (long TTL)
			cacheBehaviors: [
				{
					pathPattern: "*.{js,css,png,jpg,jpeg,gif,svg,woff,woff2}",
					allowedMethods: ["GET", "HEAD", "OPTIONS"],
					cachedMethods: ["GET", "HEAD"],
					targetOriginId: "S3",
					forwardedValues: {
						queryString: false,
						cookies: {
							forward: "none",
						},
					},
					viewerProtocolPolicy: "allow-all",
					minTtl: 0,
					defaultTtl: 31536000, // 1 year for versioned assets
					maxTtl: 31536000,
					compress: true,
				},
			],
			priceClass: "PriceClass_100", // US, Europe, Asia-Pacific
			restrictions: {
				geoRestriction: {
					restrictionType: "none",
				},
			},
			viewerCertificate: {
				cloudfrontDefaultCertificate: true,
			},
			tags: { Name: `${appName}-cdn` },
		});

		// ========================================================================
		// STACK OUTPUTS (Wave 3.1)
		// ========================================================================

		return {
			// Descope
			DescopeProjectId: descope.descopeProjectId,

			// Networking
			VpcId: vpc.id,
			PublicSubnet1: publicSubnet1.id,
			PublicSubnet2: publicSubnet2.id,
			PrivateSubnet1: privateSubnet1.id,
			PrivateSubnet2: privateSubnet2.id,

			// ECS
			EcsClusterId: ecsCluster.id,
			EcsClusterName: ecsCluster.name,
			ProcellaServiceName: procellaService.name,
			DbServiceName: dbSvc.name,

			// ALB
			AlbDnsName: alb.dnsName,
			AlbArn: alb.arn,
			TargetGroupArn: targetGroup.arn,

			// S3
			StaticAssetsBucket: staticAssetsBucket.id,
			CheckpointBlobsBucket: checkpointBlobsBucket.id,

			// CloudFront
			CloudFrontDomainName: cloudfront.domainName,
			CloudFrontDistributionId: cloudfront.id,

			// ECR
			EcrRepositoryUrl: ecrRepo.repositoryUrl,

			// Secrets
			DescopeKeySecretArn: descopeKeySecret.arn,
			EncryptionKeySecretArn: encryptionKeySecret.arn,

			// Database
			EfsId: efs.id,
			EfsAccessPointId: efsAccessPoint.id,

			// Logs
			LogGroupName: logGroup.name,
			DbLogGroupName: dbLogGroup.name,
		};
	},
});
