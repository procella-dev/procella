#!/usr/bin/env bash
set -euo pipefail

# Claude Code PreToolUse hook — reminds the agent to verify docs
# when committing code changes that might affect documentation.
#
# Exit 0 = allow, Exit 2 = block (message on stderr)

# Parse stdin JSON for the bash command
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# Only care about git commit commands
if ! echo "$COMMAND" | grep -q 'git commit'; then
  exit 0
fi

# Get staged files
STAGED=$(git diff --cached --name-only 2>/dev/null || echo "")

if [ -z "$STAGED" ]; then
  exit 0
fi

# Check if any Go/TypeScript source files changed
CODE_CHANGED=false
while IFS= read -r file; do
  case "$file" in
    cmd/*|internal/*|web/apps/*)
      CODE_CHANGED=true
      break
      ;;
  esac
done <<< "$STAGED"

if [ "$CODE_CHANGED" = false ]; then
  exit 0
fi

# Check if docs were also updated
DOCS_CHANGED=false
while IFS= read -r file; do
  case "$file" in
    AGENTS.md|README.md|docs/*|.github/workflows/ci.yml|Makefile|docker-compose.yml|Caddyfile)
      DOCS_CHANGED=true
      break
      ;;
  esac
done <<< "$STAGED"

if [ "$DOCS_CHANGED" = true ]; then
  exit 0
fi

# Code changed but no docs — warn the agent
cat >&2 << 'EOF'
CODE CHANGED WITHOUT DOCS UPDATE — Please verify before committing:

1. AGENTS.md — Does the directory structure, tech stack, or quality gates section need updating?
2. README.md — Does the project structure, tech stack table, or features list need updating?
3. docs/ (Starlight) — Do architecture/overview.md, development/testing.md, or development/contributing.md need updating?

If docs are already up to date, proceed with the commit.
If not, update docs first, then commit everything together.
EOF

exit 2
