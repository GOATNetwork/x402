#!/usr/bin/env bash
set -euo pipefail

# Deploy USDC & USDT to Metis Sepolia Testnet (chainId: 59902)
# RPC: https://sepolia.metisdevops.link
# Explorer: https://sepolia-explorer.metisdevops.link

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Check PRIVATE_KEY
if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "ERROR: PRIVATE_KEY environment variable is required"
  echo "Usage: PRIVATE_KEY=0x... bash script/deploy-metis-sepolia.sh"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "lib/forge-std" ]; then
  echo "Installing dependencies..."
  forge install foundry-rs/forge-std --no-commit
  forge install OpenZeppelin/openzeppelin-contracts --no-commit
fi

echo "=== Deploying USDC & USDT to Metis Sepolia (chainId: 59902) ==="
echo ""

# Deploy with 6 decimals
TOKEN_DECIMALS=6 forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://sepolia.metisdevops.link \
  --chain-id 59902 \
  --broadcast \
  --legacy \
  -vvvv

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Check the broadcast output above for contract addresses."
echo "Verify on explorer: https://sepolia-explorer.metisdevops.link"
