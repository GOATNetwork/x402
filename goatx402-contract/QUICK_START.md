# MerchantCallback Quick Start

`MerchantCallback` is a reference contract for an optional, operator-provisioned
callback transfer flow. It is not part of the current public DIRECT merchant setup.
DIRECT merchants should configure receiving addresses in the Merchant Portal
and skip this guide.

`topup-service` uses the separate `TopupCallback`; do not substitute
`MerchantCallback` for that internal service.

## 1. Install And Validate

From `goatx402-contract/`, install the Solidity libraries as documented in the
[`README` prerequisites](README.md#prerequisites). That section records the
current unpinned `forge-std` reproducibility blocker.

```bash
forge build
forge test --match-contract MerchantCallbackTest -vv
```

The current suite contains 16 MerchantCallback tests. It covers the two base
payment callbacks, both `withCalldata` variants, authorization, withdrawals,
EIP-712 validation, deadlines, replay protection, domain separation, and
version reporting.

## 2. Understand The Deployment

`DeployMerchantCallback` deploys:

1. a `MerchantCallback` implementation; and
2. an ERC1967 proxy initialized with the deployer as owner.

The proxy is the operational contract address. The implementation address must
not be registered as the merchant callback.

The deployment script reads the private key from `PRIVATE_KEY`. If
`X402_CALLER_ADDRESS` is nonzero, it authorizes that operator caller in the same
broadcast.

## 3. Local Anvil Deployment

Start Anvil in one terminal:

```bash
anvil
```

In another terminal, enter one of the private keys printed by that local Anvil
process and authorize a second local account as the callback caller. Reading the
key interactively keeps it out of the guide and shell history:

```bash
read -r -s PRIVATE_KEY
export PRIVATE_KEY
export X402_CALLER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url http://localhost:8545 --broadcast
```

Use the printed `Proxy (use this)` address:

```bash
export CONTRACT_ADDRESS=0x...
export RPC_URL=http://localhost:8545

cast call "$CONTRACT_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
cast call "$CONTRACT_ADDRESS" \
  "authorizedCallers(address)(bool)" "$X402_CALLER_ADDRESS" \
  --rpc-url "$RPC_URL"
cast call "$CONTRACT_ADDRESS" "version()(string)" --rpc-url "$RPC_URL"
```

Do not try to test the payment callbacks with placeholder signatures. The base
entrypoints call the supplied EIP-3009 token or Permit2 contract and require a
real authorization/permit. The Foundry suite supplies controlled mocks for this
purpose.

## 4. Guided Testnet Deployment

The helper defaults to BSC Testnet and keeps the key out of command-line
arguments:

```bash
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
```

Edit `.env.deploy`:

```dotenv
PRIVATE_KEY=0x...
X402_CALLER_ADDRESS=0x...
ETHERSCAN_API_KEY=
RPC_ALIAS=bsc_testnet
CHAIN_ID=97
```

Then run:

```bash
bash deploy-merchant-callback.sh
```

If local Foundry is unavailable, the helper uses its pinned Docker image. It
also installs missing Solidity dependencies. Set `ETHERSCAN_API_KEY` only when
you want the helper to add `--verify`.

For a direct script invocation:

```bash
read -r -s PRIVATE_KEY
export PRIVATE_KEY
export X402_CALLER_ADDRESS=0x...
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url goat_testnet3 --broadcast
```

## 5. Register With The Deployment Operator

Send the following to the operator or use the environment's approved merchant
configuration flow:

- merchant identifier;
- callback chain ID;
- deployed ERC1967 proxy address; and
- the intended authorized operator caller and environment.

The callback remains unusable until both sides agree:

- the proxy has authorized the operator caller on-chain; and
- the deployment operator has approved the callback address and ABI for that merchant.

Do not write directly to an internal database using copied SQL. The storage
schema and callback ABI are deployment-operated and may change independently of this
repository.

## 6. Monitor And Administer

Read the exact event signatures from `MERCHANT_CALLBACK.md` or the Solidity
source:

```bash
cast logs --address "$CONTRACT_ADDRESS" \
  "Eip3009CallbackReceived(address,address,address,uint256,uint256,uint256,bytes32)" \
  --rpc-url "$RPC_URL"

cast logs --address "$CONTRACT_ADDRESS" \
  "Permit2CallbackReceived(address,address,address,uint256,uint256,uint256)" \
  --rpc-url "$RPC_URL"

cast call "$CONTRACT_ADDRESS" \
  "isCalldataNonceUsed(address,uint256)(bool)" "$PAYER" "$NONCE" \
  --rpc-url "$RPC_URL"
```

Owner-only operations include:

```bash
# The examples use an encrypted Foundry keystore and prompt for its password.
cast send "$CONTRACT_ADDRESS" \
  "setAuthorizedCaller(address,bool)" "$CALLER" true \
  --rpc-url "$RPC_URL" --keystore /path/to/keystore

cast send "$CONTRACT_ADDRESS" \
  "withdrawTokens(address,address,uint256)" "$TOKEN" "$RECIPIENT" "$AMOUNT" \
  --rpc-url "$RPC_URL" --keystore /path/to/keystore
```

There are no callback-history arrays, callback counters, reset functions, or
test revert toggle in the current contract. Use emitted events and operator
order records for observability.

## 7. Calldata And Upgrade Caveats

- `withCalldata` verifies an EOA EIP-712 signature from `originalPayer`.
- The calldata is executed with `address(this).call`, so it can only invoke a
  function implemented by the proxy's current implementation.
- The bundled `testCallback` only emits an event and is a demo helper, not
  merchant business logic.
- A failed self-call emits `CalldataExecuted(..., false, ...)` but does not
  revert the token transfer.
- The source has no selector allowlist and no ERC-1271 signer support.
- `reinitialize(... )` is a one-time reinitializer at version `2`; coordinate
  any domain change with all signers and backend code.

See [`MERCHANT_CALLBACK.md`](MERCHANT_CALLBACK.md) for the complete behavior and
security model.
