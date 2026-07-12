#!/usr/bin/env bash
# ============================================================================
# One-click MerchantCallback deploy (for DELEGATE merchants).
#
# YOU provide the deployer key in .env.deploy (gitignored). This script never
# prints or transmits it — it only feeds it to forge/cast on YOUR machine.
#
# Usage:
#   1) cp .env.deploy.example .env.deploy   &&   edit .env.deploy
#        - PRIVATE_KEY              (required, 0x-prefixed deployer key; it becomes the contract OWNER)
#        - X402_CALLER_ADDRESS      (optional; the testnet3 x402d "Bob" caller from the platform admin)
#        - ETHERSCAN_API_KEY        (optional; only for --verify on bscscan)
#        - RPC_ALIAS / CHAIN_ID     (optional; default bsc_testnet / 97)
#   2) Fund the deployer address with a little gas (tBNB on BSC Testnet).
#   3) bash deploy-merchant-callback.sh
#   4) Send the printed Proxy address to your operator to register
#      (POST /callback-contracts, chain = CHAIN_ID).
#
# Foundry is auto-detected: uses local forge/cast if installed, otherwise a
# version-pinned Docker image (override FOUNDRY_IMAGE to bump/pin a digest).
# The key is only ever read from env by forge (never passed on a command line).
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"                 # -> goatx402-contract
REPO_ROOT="$(cd .. && pwd)"
ENV_FILE="${ENV_FILE:-.env.deploy}"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found. Run:  cp .env.deploy.example .env.deploy  and fill PRIVATE_KEY."; exit 1; }
set -a; . "./$ENV_FILE"; set +a
: "${PRIVATE_KEY:?PRIVATE_KEY must be set in $ENV_FILE (0x-prefixed deployer key)}"
RPC_ALIAS="${RPC_ALIAS:-bsc_testnet}"
CHAIN_ID="${CHAIN_ID:-97}"
# X402_CALLER_ADDRESS is consumed by the Solidity deploy script (vm.envOr) so the
# authorization is signed with this env key inside forge, never on a cast argv.
export PRIVATE_KEY ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}" X402_CALLER_ADDRESS="${X402_CALLER_ADDRESS:-}"

# Pin the Foundry image to an immutable content digest (not :latest, nor even a
# version tag, which the publisher could retag), so a registry change can never
# silently run replacement code while the deploy key is in scope. The v1.0.0 tag
# is kept in the reference for legibility; the @sha256 digest is what is pulled.
# Override FOUNDRY_IMAGE to bump — always to a `tag@sha256:...` digest reference.
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:v1.0.0@sha256:d12a373ec950de170d5461014ef9320ba0fb6e0db6f87835999d0fcf3820370e}"

# ---- forge/cast runner: native if present, else cached Docker foundry image ----
if command -v forge >/dev/null 2>&1 && command -v cast >/dev/null 2>&1; then
  echo "Using local Foundry."
  FORGE(){ forge "$@"; }
  CAST(){ cast "$@"; }
else
  echo "Local Foundry not found -> using Docker image $FOUNDRY_IMAGE."
  DRUN(){ docker run --rm -e PRIVATE_KEY -e ETHERSCAN_API_KEY -e X402_CALLER_ADDRESS \
            -v "$REPO_ROOT":/repo -w /repo/goatx402-contract \
            --entrypoint "$1" "$FOUNDRY_IMAGE" "${@:2}"; }
  FORGE(){ DRUN forge "$@"; }
  CAST(){ DRUN cast "$@"; }
fi

# ---- ensure Solidity deps (forge-std + OpenZeppelin) are present ----
# Prefer the pinned submodules; if this checkout's gitlinks aren't populated (e.g. a
# branch without them), self-heal by cloning the public deps directly so the build works.
( cd "$REPO_ROOT" && git submodule update --init --recursive \
    goatx402-contract/lib/forge-std \
    goatx402-contract/lib/openzeppelin-contracts \
    goatx402-contract/lib/openzeppelin-contracts-upgradeable 2>/dev/null ) || true
[ -d lib/forge-std/src ] || git clone --depth 1 -q https://github.com/foundry-rs/forge-std lib/forge-std
[ -d lib/openzeppelin-contracts/contracts ] || git clone --depth 1 -q -b v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
[ -d lib/openzeppelin-contracts-upgradeable/contracts ] || git clone --depth 1 -q -b v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable lib/openzeppelin-contracts-upgradeable
[ -d lib/forge-std/src ] && [ -d lib/openzeppelin-contracts/contracts ] || {
  echo "ERROR: contract libs missing and direct clone failed — check network/Docker."; exit 1; }

echo "== forge build =="
FORGE build

echo "== deploy MerchantCallback (impl + ERC1967 proxy) on $RPC_ALIAS =="
VERIFY_FLAG=""; [ -n "${ETHERSCAN_API_KEY:-}" ] && VERIFY_FLAG="--verify"
FORGE script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url "$RPC_ALIAS" --broadcast $VERIFY_FLAG

# ---- extract the PROXY address from the broadcast (last CREATE = the proxy) ----
BCAST="broadcast/DeployMerchantCallback.s.sol/$CHAIN_ID/run-latest.json"
PROXY=""
if [ -f "$BCAST" ]; then
  PROXY="$(python3 -c "import json,sys
d=json.load(open('$BCAST')); a=[t.get('contractAddress') for t in d.get('transactions',[]) if t.get('contractAddress')]
print(a[-1] if a else '')" 2>/dev/null || true)"
fi

echo ""
echo "=================== RESULT ==================="
echo "Proxy address (register this as spent_address): ${PROXY:-<see $BCAST>}"
echo "=============================================="

# ---- x402 caller (Bob) authorization ----
# When X402_CALLER_ADDRESS is set it is authorized DURING deployment by the Solidity
# script (env-signed inside forge), so no separate `cast send --private-key` is run
# here and the deploy key never appears in a process argument list.
if [ -n "${X402_CALLER_ADDRESS:-}" ]; then
  echo "== x402 caller $X402_CALLER_ADDRESS authorized during deploy =="
else
  echo "NOTE: X402_CALLER_ADDRESS not set -> setAuthorizedCaller SKIPPED."
  echo "      Get the testnet3 x402d 'Bob' caller address from the platform admin, then"
  echo "      re-run this script with X402_CALLER_ADDRESS set (it is authorized in-deploy,"
  echo "      keeping the key out of any command line). Without it the callback reverts"
  echo "      with UnauthorizedCaller."
fi

echo ""
echo "NEXT: send the Proxy address to your operator to register the callback contract"
echo "      (POST /callback-contracts with chain_id=$CHAIN_ID, spent_address=<Proxy>); approval makes it active."
