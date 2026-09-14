#!/usr/bin/env bash
# infra/backup/restore-drill.sh (P29a Unit U3, step 9) - POSIX twin of
# restore-drill.ps1. Loads `.secrets/dev.env`, then runs the TS orchestrator.
#
# Usage:
#   infra/backup/restore-drill.sh
#   infra/backup/restore-drill.sh --keep
#   infra/backup/restore-drill.sh --mode pgbackrest
#   infra/backup/restore-drill.sh --allow-remote-source   # required opt-in when POSTGRES_HOST is not loopback; a production-pattern-matching source is still refused regardless

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.secrets/dev.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
set +a

pnpm exec tsx infra/backup/restore-drill.ts "$@"
