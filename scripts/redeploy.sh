#!/usr/bin/env bash
# Rebuilds the whole demo on the devnet in one run: token, pool, liquidity, staked paymaster, registration, smoke test.
# The deployer key comes from the git-ignored .env, and a new one is generated there if it is missing.
#
#   scripts/redeploy.sh --fresh                  replaces deployments/devnet.json
#   scripts/redeploy.sh --fresh --seed-eth 0.3   with more liquidity
#   scripts/redeploy.sh --out /tmp/test.json     rehearses, leaving deployments/devnet.json alone
set -euo pipefail
cd "$(dirname "$0")/.."
forge build --root contracts
pnpm exec tsx scripts/redeploy.ts "$@"
