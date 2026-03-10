# Procella AWS ECS Deployment Guide

## Overview

Procella is a self-hosted Pulumi backend that can be deployed to AWS using ECS (Elastic Container Service) for the API server and PostgreSQL database, with static assets served via S3 and CloudFront.

- **Cost**: ~$150/month (ECS Fargate + PostgreSQL + EFS + S3 + CloudFront + ALB)
- **Architecture**: VPC with public/private subnets, ALB, ECS Fargate for server and database, EFS for persistent storage, S3 for blobs and static assets, CloudFront CDN
- **Scalability**: Stateless server architecture, horizontal auto-scaling (2-10 replicas), PostgreSQL on ECS with EFS for state

## Prerequisites

Before starting, ensure you have:

### AWS Account
- AWS account with permissions for:
  - EC2, ECS, S3, CloudFront, Route53, Secrets Manager, CloudWatch, IAM, EFS, ALB
  - Ability to create VPCs, subnets, security groups, and other networking resources

### Domain
- Domain name (e.g., `strata.com`)
- Route53 hosted zone for your domain (SST will create or update this)
- Subdomains will be created automatically:
  - `strata.strata.com` — React SPA web UI
  - `api.strata.com` — API server (Pulumi CLI)
  - `docs.strata.com` — Astro documentation site

### Descope Authentication
- Descope account and project
- Project ID from [Descope Dashboard](https://app.descope.com)
- Management API key for token creation and user management

### Local Tools
- **Bun CLI** v1.2+ — [Install Bun](https://bun.sh)
- **AWS CLI** — Configured with credentials ([Install AWS CLI](https://aws.amazon.com/cli/))
  ```bash
  aws configure
  # Enter AWS Access Key ID, Secret Access Key, region, output format
  ```
- **Git** — For cloning the repository
- **PostgreSQL client (optional)** — `psql` for database verification ([Install PostgreSQL](https://www.postgresql.org/download/))

## Environment Variables

The deployment uses these variables, set via `.env` file or environment:

| Variable | Source | Example | Required |
|----------|--------|---------|----------|
| `PROCELLA_DESCOPE_PROJECT_ID` | Your Descope dashboard | `proj_abc123xyz...` | ✅ Yes |
| `PROCELLA_DESCOPE_MANAGEMENT_KEY` | Your Descope API key | (sensitive, 100+ chars) | ✅ Yes |
| `PROCELLA_DB_PASSWORD` | You set or auto-generate | (any strong password) | ❌ No (defaults to "strata") |
| `PROCELLA_CORS_ORIGINS` | Auto-configured | `https://strata.strata.com` | Auto |
| `PROCELLA_DATABASE_URL` | Auto-configured | `postgresql://strata:...@strata-db.local:5432/strata` | Auto |
| `PROCELLA_BLOB_S3_BUCKET` | Auto-created | `procella-checkpoints-1234...` | Auto |
| `PROCELLA_ENCRYPTION_KEY` | Auto-generated | (64 hex chars) | Auto |

- **Auto-configured**: SST populates these from infrastructure
- **Auto-generated**: SST generates secure values
- **You provide**: Descope credentials (required) and DB password (optional)

## Step-by-Step Deployment

### 1. Prerequisites Check

Verify all tools are installed:

```bash
bun --version
# Should print: bun v1.2.x or later

aws --version
# Should print: aws-cli/2.x.x

git --version
# Should print: git version 2.x.x
```

### 2. Clone Repository

```bash
git clone https://github.com/your-org/strata-iac.git
cd strata
```

### 3. Configure Environment

Create `.env` file with your Descope credentials:

```bash
cp .env.example .env

# Edit .env with your values:
cat > .env << 'EOF'
# Descope Authentication
PROCELLA_DESCOPE_PROJECT_ID=your-project-id-from-descope-dashboard
PROCELLA_DESCOPE_MANAGEMENT_KEY=your-management-api-key-from-descope-dashboard

# Optional: Database password (defaults to "strata" if not provided)
PROCELLA_DB_PASSWORD=your-secure-password-here
EOF

# Verify the file
cat .env
```

### 4. Deploy Infrastructure

#### Preview Changes (Recommended)

Before deploying, see what resources will be created:

```bash
# Dry-run mode shows all changes without creating resources
bun run infra:deploy --dry-run
# or
sst diff
```

Review the output to verify:
- VPC and subnets are created
- ECS cluster and services are created
- S3 buckets for static assets and checkpoints
- CloudFront distributions for CDN
- RDS/PostgreSQL configuration
- Route53 records for your domain

#### Deploy to AWS

```bash
# Deploy to AWS (production stage)
bun run infra:deploy

# Or with explicit stage
SST_STAGE=production bun run infra:deploy

# This will take 5-10 minutes to complete
```

The deployment will output stack information including:
- ALB DNS name (e.g., `strata-alb-123.us-east-1.elb.amazonaws.com`)
- CloudFront domain names (UI and docs CDNs)
- S3 bucket names
- RDS endpoint (or PostgreSQL ECS service for ECS-based database)
- Route53 hosted zone ID

Save this information—you'll need it for verification and troubleshooting.

### 5. Configure DNS

#### Option A: Route53 (Recommended)

If SST created a Route53 hosted zone:

```bash
# List Route53 zones
aws route53 list-hosted-zones-by-name

# Find your strata.com zone
# SST automatically created A records for:
#   - strata.strata.com → CloudFront UI distribution
#   - api.strata.com → ALB DNS
#   - docs.strata.com → CloudFront docs distribution

# Verify records were created
aws route53 list-resource-record-sets --hosted-zone-id /hostedzone/Z1234567890ABC
```

If your domain registrar is external (GoDaddy, Namecheap, etc.):
1. Copy the 4 nameservers from Route53 zone
2. Update your domain registrar's nameserver configuration
3. Wait 5-15 minutes for DNS propagation

#### Option B: External Domain Registrar

If you're using your existing domain registrar:

```bash
# Get nameservers from Route53 zone
aws route53 get-hosted-zone --id /hostedzone/Z1234567890ABC

# Create CNAME records at your registrar:
#   - strata.strata.com CNAME → <CloudFront-UI-domain>
#   - api.strata.com CNAME → <ALB-DNS-name>
#   - docs.strata.com CNAME → <CloudFront-docs-domain>
```

### 6. Initialize Database (First Deployment Only)

For a new deployment, initialize the database:

```bash
# Get database connection URL from stack output
PROCELLA_DB_URL=$(aws ssm get-parameter --name /strata/database-url --query Parameter.Value --output text)

# Run database migrations (if any exist)
bun run --cwd packages/db migrate

# Verify database is accessible
psql "$PROCELLA_DB_URL" -c "SELECT version();"
```

### 7. Verify Deployment

Once DNS has propagated (5-15 minutes), verify all services are running:

#### Health Checks

```bash
# API server health check
curl https://api.strata.com/healthz
# Should return: HTTP 200 OK

# Get Pulumi stacks (should be empty list initially)
curl -H "Authorization: token <your-api-token>" https://api.strata.com/api/stacks
# Should return: {"stacks": []} or similar
```

#### Access Web UI

```bash
# Open React SPA
open https://strata.strata.com

# Should display: Procella login page or stack list
```

#### Access Documentation

```bash
# Open Astro docs
open https://docs.strata.com

# Should display: Procella documentation homepage
```

#### CloudFront Caching

Verify CloudFront is caching correctly:

```bash
# Check cache headers for static assets
curl -I https://strata.strata.com/assets/main.js
# Should include: Cache-Control: max-age=31536000,immutable

# Check cache headers for HTML
curl -I https://strata.strata.com/index.html
# Should include: Cache-Control: max-age=0,s-maxage=3600 (no browser cache, 1hr CDN cache)
```

## Cost Breakdown

### Monthly Estimated Cost: ~$150

| Component | Estimated Cost | Details |
|-----------|---|---|
| **ECS Fargate** (API server) | $40-80/month | 2-10 replicas, 0.5 vCPU, 1GB RAM each, auto-scaling on CPU>70% |
| **ECS Fargate** (PostgreSQL) | $20-40/month | 1 replica, 0.5 vCPU, 1GB RAM (database always on) |
| **EFS Storage** | $9/month | 30GB typical usage, $0.30/GB/month |
| **S3 Storage** | $5-10/month | Static assets + checkpoint blobs, infrequent access |
| **CloudFront** | $20/month | ~1TB egress monthly (typical), $0.085/GB |
| **ALB** | $15-20/month | Fixed hourly + data processing fees |
| **Total** | **~$150/month** | Varies by traffic, storage, and egress |

### Cost Comparison

This is ~12x cheaper than hosted alternatives:

| Solution | Monthly Cost | Notes |
|----------|---|---|
| **Procella on ECS** (this setup) | ~$150 | Self-hosted, full control |
| **RDS PostgreSQL** | $1,800+ | Managed database alone |
| **Pulumi Cloud** | $10-500+ | Hosted Pulumi backend as service |

### Cost Optimization

- **Reserved Instances**: Commit to 1-year term for 20-30% discount
- **ECS Fargate Spot**: Use spot instances for non-critical workloads (50-70% cheaper)
- **S3 Intelligent Tiering**: Auto-archive old backups
- **CloudFront Caching**: Maximize cache hit ratio to reduce egress

## Updating Deployments

### Deploy New Version

```bash
# Make code changes and commit
git add .
git commit -m "feat: add new feature"
git push origin main

# GitHub Actions automatically:
# 1. Builds Docker image
# 2. Pushes to ECR
# 3. Updates ECS service
# 4. Waits for health checks to pass
```

Monitor deployment progress:

```bash
# Watch ECS service
aws ecs describe-services --cluster strata --services strata-server --region us-east-1

# Stream logs
aws logs tail /ecs/strata-server --follow --region us-east-1
```

### Configuration Changes

```bash
# Edit sst.config.ts or environment
git add sst.config.ts .env
git commit -m "config: update CORS origins"
git push origin main

# Redeploy infrastructure
bun run infra:deploy
```

### Rollback to Previous Version

```bash
# List previous task definitions
aws ecs list-task-definitions --family-prefix strata-server --region us-east-1

# Describe previous task definition to get its ARN
aws ecs describe-task-definition --task-definition strata-server:5 --region us-east-1

# Update service to use previous task definition
aws ecs update-service \
  --cluster strata \
  --service strata-server \
  --task-definition strata-server:4 \
  --region us-east-1
```

## Troubleshooting

### API Server Returns 502/503

```bash
# Check ECS task status
aws ecs describe-services --cluster strata --services strata-server --region us-east-1

# Stream logs to find errors
aws logs tail /ecs/strata-server --follow --region us-east-1

# Look for: Database connection errors, port binding issues, missing env vars

# If task is crashing, check task definition
aws ecs describe-task-definition --task-definition strata-server --region us-east-1
```

### Database Connection Failed

```bash
# Check PostgreSQL task logs
aws logs tail /ecs/strata-db --follow --region us-east-1

# Verify security group allows ECS → PostgreSQL (port 5432)
aws ec2 describe-security-groups --filters "Name=group-name,Values=strata-db" --region us-east-1

# Connect to database container
aws ecs execute-command \
  --cluster strata \
  --task <task-id> \
  --container strata-db \
  --interactive \
  --command "/bin/bash" \
  --region us-east-1

# Inside container:
psql -c "SELECT 1;"
```

### CloudFront Caching Issues

```bash
# Invalidate CloudFront cache (all paths)
aws cloudfront create-invalidation \
  --distribution-id E1234567890ABC \
  --paths "/*" \
  --region us-east-1

# Check CloudFront cache statistics
aws cloudfront get-distribution-statistics \
  --id E1234567890ABC \
  --region us-east-1
```

### DNS Not Resolving

```bash
# Check Route53 records
aws route53 list-resource-record-sets \
  --hosted-zone-id /hostedzone/Z1234567890ABC

# Test DNS resolution
nslookup strata.strata.com
dig strata.strata.com +short

# If not resolving:
# 1. Check Route53 records exist for all subdomains
# 2. Verify nameservers are set at domain registrar
# 3. Wait 5-15 minutes for DNS propagation
```

### ALB Target Group Unhealthy

```bash
# Check target group health
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:... \
  --region us-east-1

# If unhealthy, check ECS task logs
aws logs tail /ecs/strata-server --follow --region us-east-1

# Health check endpoint
curl http://ALB_DNS/healthz
# Should return 200 OK
```

## Operations & Monitoring

### CloudWatch Dashboards

Monitor infrastructure:

```bash
# View CloudWatch logs for application errors
aws logs tail /ecs/strata-server --follow

# View CloudWatch logs for database
aws logs tail /ecs/strata-db --follow

# Get CloudWatch metrics (CPU, memory, requests)
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=strata-server Name=ClusterName,Value=strata \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Average,Maximum
```

### Auto-Scaling

ECS automatically scales based on CPU utilization:

- **Minimum replicas**: 2
- **Maximum replicas**: 10
- **Scale-out trigger**: CPU > 70% (adds replicas after 300s)
- **Scale-in trigger**: CPU < 20% (removes replicas after 300s)

Monitor scaling:

```bash
# Check current replica count
aws ecs describe-services --cluster strata --services strata-server

# View scaling history
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/strata/strata-server
```

### Backups

#### EFS Snapshots (Database)

```bash
# Create manual EFS snapshot
aws ec2 create-snapshot \
  --volume-id <efs-id> \
  --description "Procella PostgreSQL backup"

# List snapshots
aws ec2 describe-snapshots --filters "Name=volume-id,Values=<efs-id>"
```

#### S3 Versioning (State & Assets)

S3 buckets have versioning enabled automatically:

```bash
# List object versions
aws s3api list-object-versions --bucket procella-checkpoints-xxx

# Restore previous version
aws s3api get-object \
  --bucket procella-checkpoints-xxx \
  --key state.json \
  --version-id <version-id> \
  state.json
```

## Support & Resources

- **Procella Documentation**: https://docs.strata.com/
- **Pulumi Service API**: https://www.pulumi.com/docs/concepts/how-pulumi-works/service/
- **AWS ECS Documentation**: https://docs.aws.amazon.com/ecs/
- **SST Documentation**: https://sst.dev/docs/
- **Descope Authentication**: https://docs.descope.com/

## Next Steps

1. ✅ Deploy infrastructure (this guide)
2. ⬜ Configure custom monitoring and alerts
3. ⬜ Set up automated backups (EFS snapshots, S3 versioning)
4. ⬜ Configure multi-region failover (advanced)
5. ⬜ Integrate with existing CI/CD pipeline

---

**Last Updated**: March 10, 2026
**Procella Version**: 1.0.0
