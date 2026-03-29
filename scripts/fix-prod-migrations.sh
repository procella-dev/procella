#!/usr/bin/env bash
# Fix production migration state and re-run migrations.
#
# Root cause: DB was set up via `drizzle-kit push` (no migration tracking).
# Drizzle ORM v0.45 stores tracking in "drizzle"."__drizzle_migrations".
# The table exists but is empty, so every Lambda invocation replays from
# migration 0000, hitting "CREATE TABLE checkpoints" which already exists.
#
# This script:
# 1. Seeds drizzle.__drizzle_migrations with hashes for 0000-0002 (already applied)
# 2. Invokes the migrate Lambda (applies 0005, 0007, 0008)
# 3. Verifies success
#
# Usage:
#   export AWS_ACCESS_KEY_ID="..."
#   export AWS_SECRET_ACCESS_KEY="..."
#   export AWS_SESSION_TOKEN="..."
#   bash scripts/fix-prod-migrations.sh

set -euo pipefail

CLUSTER_ARN="arn:aws:rds:us-east-1:159232785545:cluster:procella-production-procelladatabasecluster-bcevwotf"
SECRET_ARN="arn:aws:secretsmanager:us-east-1:159232785545:secret:procella-production-ProcellaDatabaseProxySecret-tsnfuakc-B9H5Cj"
DATABASE="procella"
REGION="us-east-1"
MIGRATE_FN="procella-production-ProcellaMigrateFunction-bcfbcffh"

rds_exec() {
  aws rds-data execute-statement \
    --resource-arn "$CLUSTER_ARN" \
    --secret-arn "$SECRET_ARN" \
    --database "$DATABASE" \
    --region "$REGION" \
    --sql "$1" \
    --output json
}

echo "=== Step 0: Verify AWS credentials ==="
aws sts get-caller-identity --region "$REGION" --output json || {
  echo "ERROR: Invalid AWS credentials. Export AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN first."
  exit 1
}

echo ""
echo "=== Step 1: Check current migration state ==="
echo "Checking drizzle.__drizzle_migrations..."
CURRENT=$(rds_exec 'SELECT count(*) FROM "drizzle"."__drizzle_migrations"' 2>&1) || {
  echo "Table might not exist yet. Checking schema..."
  rds_exec 'SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = '"'"'__drizzle_migrations'"'"'' || true
}
echo "Current state: $CURRENT"

echo ""
echo "=== Step 2: Seed migration tracking table ==="
echo "Inserting hashes for migrations 0000, 0001, 0002 (already applied via push)..."

rds_exec 'CREATE SCHEMA IF NOT EXISTS "drizzle"' || true
rds_exec 'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" ("id" serial PRIMARY KEY, "hash" text NOT NULL, "created_at" bigint)' || true

COUNT=$(rds_exec 'SELECT count(*) as c FROM "drizzle"."__drizzle_migrations"' | python3 -c "import sys,json; print(json.load(sys.stdin)['records'][0][0].get('longValue', 0))" 2>/dev/null || echo "0")
if [ "$COUNT" != "0" ]; then
  echo "WARNING: Table already has $COUNT entries. Showing existing:"
  rds_exec 'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at'
  echo ""
  read -p "Table not empty. Truncate and re-seed? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Skipping seed, proceeding to Lambda invocation..."
  else
    rds_exec 'TRUNCATE "drizzle"."__drizzle_migrations"'
    COUNT=0
  fi
fi

if [ "$COUNT" = "0" ]; then
  rds_exec "INSERT INTO \"drizzle\".\"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES ('d08c6946618efc69eaf1205c6fad01748d2677d32ea36a19abd904826a0797d0', 1772914464231)"
  echo "  ✓ 0000_medical_fabian_cortez (base tables)"

  rds_exec "INSERT INTO \"drizzle\".\"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES ('3b7fc8e1f51df2656288a7ad12d30074f8fa5b588f300e950aab339ecdb2c180', 1772914500000)"
  echo "  ✓ 0001_add_journal_entries"

  rds_exec "INSERT INTO \"drizzle\".\"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES ('8c05735d18ad239e43ff5d59d7ae86aeebaf0733f8327ec29f04c40c74df4142', 1772914600000)"
  echo "  ✓ 0002_extend_journal_entries"

  echo "Seeded 3 migrations. Remaining 0005, 0007, 0008 will be applied by Lambda."
fi

echo ""
echo "=== Step 3: Invoke migrate Lambda ==="
echo "Invoking $MIGRATE_FN..."
aws lambda invoke \
  --function-name "$MIGRATE_FN" \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 360 \
  --region "$REGION" \
  /tmp/migrate-result.json

echo ""
echo "=== Step 4: Check result ==="
cat /tmp/migrate-result.json
echo ""

if grep -q '"errorMessage"' /tmp/migrate-result.json 2>/dev/null; then
  echo ""
  echo "❌ Migration FAILED. Check error above."
  exit 1
fi

echo ""
echo "✅ Migration succeeded!"
echo ""
echo "=== Step 5: Verify search_vector column exists ==="
rds_exec "SELECT column_name FROM information_schema.columns WHERE table_name = 'stacks' AND column_name = 'search_vector'"

echo ""
echo "=== Step 6: Verify all migrations recorded ==="
rds_exec 'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at'

echo ""
echo "Done! Try: pulumi stack init -s test"
