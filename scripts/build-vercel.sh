#!/usr/bin/env bash
set -euo pipefail

# Build script for Vercel Build Output API.
# Produces .vercel/output/ with static files and a serverless function.

OUT=".vercel/output"
rm -rf "$OUT"

# 1. Typecheck
echo "→ Typecheck"
bun run typecheck

# 1b. Run database migrations (Neon connection via PROCELLA_DATABASE_URL)
echo "→ Migrate database"
bunx drizzle-kit migrate --config packages/db/drizzle.config.ts

# 2. Build UI (static)
echo "→ Build UI"
bun run --cwd apps/ui build
mkdir -p "$OUT/static"
cp -rf apps/ui/dist/* "$OUT/static/"

# 3. Bundle API function
echo "→ Bundle API"
FUNC_DIR="$OUT/functions/api/index.func"
mkdir -p "$FUNC_DIR"
bun build apps/server/src/vercel.ts --target=node --outfile="$FUNC_DIR/index.mjs" --format=esm

cat > "$FUNC_DIR/.vc-config.json" << 'EOF'
{
  "runtime": "nodejs22.x",
  "handler": "index.mjs",
  "maxDuration": 60,
  "launcherType": "Nodejs"
}
EOF

# 4. Write config.json (rewrites)
cat > "$OUT/config.json" << 'EOF'
{
  "version": 3,
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/index" },
    { "src": "/trpc/(.*)", "dest": "/api/index" },
    { "src": "/healthz", "dest": "/api/index" },
    { "src": "/cron/(.*)", "dest": "/api/index" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
EOF

echo "✓ Build complete → $OUT"
