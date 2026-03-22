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
# Skip if SKIP_MIGRATIONS=1 (e.g. when CI runs migrations in a separate job).
if [ "${SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "→ Skip migrations (SKIP_MIGRATIONS=1)"
elif [ -n "${PROCELLA_DATABASE_URL:-}" ]; then
  echo "→ Migrate database"
  bunx drizzle-kit migrate --config packages/db/drizzle.config.ts
else
  echo "→ Skip migrations (PROCELLA_DATABASE_URL not set)"
fi

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

# 4. Write config.json (host-based routing for multi-domain setup)
#    procella.sh       → landing page only (redirects dashboard paths to app.procella.sh)
#    app.procella.sh   → full SPA + API (default)
#    api.procella.sh   → API-only (404 for non-API paths)
#    *.vercel.app      → passthrough (preview environments)
cat > "$OUT/config.json" << 'EOF'
{
  "version": 3,
  "routes": [
    { "src": "/api(?:/(.*))?"  , "has": [{"type":"host","value":"api.procella.sh"}], "dest": "/api/index" },
    { "src": "/trpc(?:/(.*))?" , "has": [{"type":"host","value":"api.procella.sh"}], "dest": "/api/index" },
    { "src": "/healthz"        , "has": [{"type":"host","value":"api.procella.sh"}], "dest": "/api/index" },
    { "src": "/cron(?:/(.*))?" , "has": [{"type":"host","value":"api.procella.sh"}], "dest": "/api/index" },
    { "src": "/(.*)"           , "has": [{"type":"host","value":"api.procella.sh"}], "status": 404 },

    { "src": "/api(?:/(.*))?" , "dest": "/api/index" },
    { "src": "/trpc(?:/(.*))?" , "dest": "/api/index" },
    { "src": "/healthz"       , "dest": "/api/index" },
    { "src": "/cron(?:/(.*))?" , "dest": "/api/index" },

    { "handle": "filesystem" },

    { "src": "/(.+)", "has": [{"type":"host","value":"procella.sh"}], "headers": {"Location": "https://app.procella.sh/$1"}, "status": 308 },

    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
EOF

echo "✓ Build complete → $OUT"
