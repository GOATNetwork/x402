# goatx402-contract

This project contains the smart contracts for goatx402, including:
- `USDC`: ERC20 token with EIP-3009 support and configurable decimals.
- `USDT`: Standard ERC20 token with configurable decimals.
- `MerchantCallback`: Callback contract for merchant payment notifications.
- `TopupCallback`: Dedicated topup-service callback without arbitrary calldata execution.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)

## Configuration

1.  Copy `.env.example` to `.env` (or create it) and fill in your keys:
    ```bash
    PRIVATE_KEY=your_private_key
    BSC_SCAN_API_KEY=your_bsc_scan_api_key
    ETHERSCAN_API_KEY=your_etherscan_api_key
    # For Goat Testnet3 (Blockscout), you might not need an API key, or use any value if required by forge
    GOAT_SCAN_API_KEY=any_value
    ```

2.  Load environment variables:
    ```bash
    source .env
    ```

## Token Decimals

The USDC and USDT contracts support configurable decimals during deployment. This allows simulating different chain configurations:

| Chain | USDC Decimals | USDT Decimals |
|-------|---------------|---------------|
| Ethereum / Sepolia | 6 | 6 |
| BSC / BSC Testnet | 18 | 18 |
| Goat Testnet3 | 6 (default) | 6 (default) |
| Metis Sepolia | 6 | 6 |

Set the `TOKEN_DECIMALS` environment variable before deployment:

```bash
# Deploy with 6 decimals (ETH-style, default)
forge script script/Deploy.s.sol --rpc-url sepolia --broadcast

# Deploy with 18 decimals (BSC-style)
TOKEN_DECIMALS=18 forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast
```

## Deployment

### Sepolia (ETH Testnet)

Deploy with 6 decimals (Ethereum standard):

```bash
# Deploy and verify
forge script script/Deploy.s.sol \
  --rpc-url sepolia \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Or with explicit decimals
TOKEN_DECIMALS=6 forge script script/Deploy.s.sol \
  --rpc-url sepolia \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

### BSC Testnet

Deploy with 18 decimals (BSC standard):

```bash
# Deploy and verify
TOKEN_DECIMALS=18 forge script script/Deploy.s.sol \
  --rpc-url bsc_testnet \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

Manual verification (if needed):

```bash
# Verify USDC (replace with your contract address and deployer address)
forge verify-contract \
  --chain-id 97 \
  <USDC_CONTRACT_ADDRESS> \
  src/USDC.sol:USDC \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint8)" <DEPLOYER_ADDRESS> 18) \
  --watch

# Verify USDT (replace with your contract address and deployer address)
forge verify-contract \
  --chain-id 97 \
  <USDT_CONTRACT_ADDRESS> \
  src/USDT.sol:USDT \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint8)" <DEPLOYER_ADDRESS> 18) \
  --watch
```

### Goat Testnet3

Deploy with default 6 decimals:

```bash
# Set dummy API key for Blockscout (may not require actual key)
export GOAT_SCAN_API_KEY="dummy"

# Deploy and verify using Blockscout
forge script script/Deploy.s.sol \
  --rpc-url goat_testnet3 \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://explorer.testnet3.goat.network/api
```

Or with custom decimals:

```bash
TOKEN_DECIMALS=6 forge script script/Deploy.s.sol \
  --rpc-url goat_testnet3 \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://explorer.testnet3.goat.network/api
```

## MerchantCallback Deployment

See [QUICK_START.md](./QUICK_START.md) for MerchantCallback deployment instructions.

```bash
# BSC Testnet
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url bsc_testnet \
  --broadcast \
  --verify \
  --etherscan-api-key $BSC_SCAN_API_KEY

# Goat Testnet3
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url goat_testnet3 \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://explorer.testnet3.goat.network/api

# Sepolia
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url sepolia \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

For a guided deployment that keeps the key in a gitignored local file, copy
`.env.deploy.example` to `.env.deploy` and run `bash deploy-merchant-callback.sh`.

## TopupCallback Deployment

`TopupCallback` is only for the platform topup-service merchant. It uses the
EIP-712 domain `GoatX402 Topup Callback` / `1` and intentionally omits
`withCalldata` callback methods. Regular merchants should use `MerchantCallback`.

```bash
PRIVATE_KEY=<OWNER_KEY> AUTHORIZED_CALLER=<X402_CALLER> \
  forge script script/DeployTopupCallback.s.sol:DeployTopupCallback \
  --rpc-url goat_testnet3 --broadcast
```

## Contracts

- `src/USDC.sol`: Implements ERC20, Ownable, and EIP712 for EIP-3009 (TransferWithAuthorization). Supports configurable decimals.
- `src/USDT.sol`: Implements standard ERC20 and Ownable. Supports configurable decimals.
- `src/MerchantCallback.sol`: Upgradeable callback contract for receiving payment notifications via EIP-3009 or Permit2.
- `src/TopupCallback.sol`: Upgradeable, topup-specific EIP-3009 / Permit2 receiver with exact-amount checks.

## Testing

```bash
# Run all tests
forge test

# Run with verbosity
forge test -vvv

# Run specific test
forge test --match-contract MerchantCallbackTest -vv

# Run topup callback tests
forge test --match-contract TopupCallbackTest -vv
```

## Chain Configuration

| Network | Chain ID | RPC URL | Explorer |
|---------|----------|---------|----------|
| BSC Testnet | 97 | https://data-seed-prebsc-1-s1.binance.org:8545 | https://testnet.bscscan.com |
| Goat Testnet3 | 48816 | https://rpc.testnet3.goat.network | https://explorer.testnet3.goat.network |
| Sepolia | 11155111 | https://rpc.sepolia.org | https://sepolia.etherscan.io |
| Metis Sepolia | 59902 | https://sepolia.metisdevops.link | https://sepolia-explorer.metisdevops.link |
