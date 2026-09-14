#!/usr/bin/env bash
# restore-drill.sh - moved to infra/backup/ in P29a. This forwarder exists
# only so existing references to this path keep resolving.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$REPO_ROOT/infra/backup/restore-drill.sh" "$@"
