#!/bin/bash
set -euo pipefail

# Make host-installed go and bun available in the container's PATH.
# These directories are volume-mounted from the GitHub Actions runner
# by the workflow (see .github/workflows/renovate.yml).
ln -sf /mise-bun/bun /usr/local/bin/bun
export GOROOT=/usr/local/go
export PATH="/usr/local/go/bin:$PATH"

exec renovate
