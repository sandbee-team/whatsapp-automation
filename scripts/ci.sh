#!/usr/bin/env bash
# Human entrypoint for CI on the deploy box. Preflight only - every actual
# step lives in scripts/ci-steps.ts. Do not add step commands here (see
# ci_ps1_and_ci_sh_run_the_same_ordered_steps).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm_version="$(pnpm --version)"
if [[ "$pnpm_version" != 10.* ]]; then
  echo "Expected pnpm 10.x, got '$pnpm_version'. Install/activate pnpm 10 before running CI." >&2
  exit 1
fi

node_version="$(pnpm node --version)"
if [[ "$node_version" != v24.* ]]; then
  echo "Expected Node v24.x (via pnpm), got '$node_version'. Check .npmrc use-node-version." >&2
  exit 1
fi

echo "Preflight OK: pnpm $pnpm_version, node $node_version"
echo "Delegating to scripts/ci-steps.ts ..."

pnpm exec tsx scripts/ci-steps.ts run
