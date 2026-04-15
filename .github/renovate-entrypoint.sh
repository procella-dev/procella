#!/bin/bash
set -euo pipefail

# Go is volume-mounted as a directory tree at /usr/local/go.
# Bun is volume-mounted as a single binary directly at /usr/local/bin/bun.
# (see .github/workflows/renovate.yml for the volume mounts)
#
# Verify tools are accessible before handing off to Renovate.
echo "bun: $(bun --version 2>&1 || echo 'NOT FOUND')"
echo "go:  $(go version 2>&1 || echo 'NOT FOUND')"

export GOROOT=/usr/local/go
export PATH="/usr/local/go/bin:$PATH"

exec renovate
