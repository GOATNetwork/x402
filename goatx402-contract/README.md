# goatx402-contract

Foundry project for callback-contract development and local payment-token
testing.

## Scope And Product Status

These contracts are **not required for the current public DIRECT merchant
product**. A DIRECT payer transfers tokens to the merchant's configured
receiving address and does not call a merchant callback contract.

| Contract | Intended use |
| --- | --- |
| [`MerchantCallback`](src/MerchantCallback.sol) | Reference UUPS receiver for an optional, operator-provisioned callback transfer flow |
| [`TopupCallback`](src/TopupCallback.sol) | Dedicated internal receiver for `topup-service` |
| [`USDC`](src/USDC.sol) | Mintable EIP-3009 test token with configurable decimals |
| [`USDT`](src/USDT.sol) | Mintable ERC-20 test token with configurable decimals |

`USDC` and `USDT` are development tokens. Their names and symbols do not make
them canonical or production assets.

## Prerequisites

- Foundry with Solidity `0.8.24` support
- Git, or Docker when using `deploy-merchant-callback.sh`
- RPC access and native gas only when broadcasting

The Solidity libraries are not committed in this checkout. Install them before
manual builds:

```bash
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-commit
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-commit
```

> **Known reproducibility blocker:** the `forge-std` install is not pinned to a
> tag or commit. Do not treat a contract build or deployment artifact as
> reproducible release evidence until a pinned revision is reviewed and merged.
> The Foundry project is outside the npm release runbook.

The MerchantCallback helper tries the same dependency setup automatically when
the libraries are absent.

## Build And Test

```bash
forge build
forge test

# Focused suites
forge test --match-contract MerchantCallbackTest -vv
forge test --match-contract TopupCallbackTest -vv
```

The current source has 16 `MerchantCallbackTest` cases and 8
`TopupCallbackTest` cases. Treat the command result, not a copied gas snapshot,
as authoritative.

## Test Tokens

`script/Deploy.s.sol:DeployScript` deploys both test tokens to the selected
network. It reads:

- `PRIVATE_KEY` - required deployer/initial owner key
- `TOKEN_DECIMALS` - optional, defaults to `6`

```bash
export PRIVATE_KEY=0x...
TOKEN_DECIMALS=6 forge script script/Deploy.s.sol:DeployScript \
  --rpc-url goat_testnet3 --broadcast
```

Both tokens mint `1,000,000,000 * 10^decimals` units to the deployer. Choose
decimals to match the test scenario; do not infer a production token's decimals
from this script.

## MerchantCallback

Read [`QUICK_START.md`](QUICK_START.md) for the deployment sequence and
[`MERCHANT_CALLBACK.md`](MERCHANT_CALLBACK.md) for the ABI and security model.
In particular, the current `withCalldata` self-call has no selector allowlist;
any function exposed by the proxy implementation can be attempted with
properly signed calldata.

The supported helper uses a gitignored local environment file:

```bash
cp .env.deploy.example .env.deploy
# Set PRIVATE_KEY and, preferably, X402_CALLER_ADDRESS.
bash deploy-merchant-callback.sh
```

The helper:

1. builds the contracts;
2. deploys a `MerchantCallback` implementation and ERC1967 proxy;
3. optionally authorizes `X402_CALLER_ADDRESS` in the deployment broadcast; and
4. prints the proxy address that must be registered with the deployment operator.

Its defaults are BSC Testnet (`RPC_ALIAS=bsc_testnet`, `CHAIN_ID=97`). Change
both values together for another configured network. Register the **proxy**, not
the implementation.

## TopupCallback

`TopupCallback` is for the internal `topup-service`, not a regular merchant. It
has no `withCalldata` entrypoints and checks the exact token balance increase
for each callback.

Although it initializes and exposes an EIP-712 domain, `TopupCallback` does not
hash or recover the EIP-3009 or Permit2 payment signatures itself. The supplied
token contract validates EIP-3009 authorization, and the supplied Permit2
contract validates Permit2 signatures. The callback adds authorized-caller
gating and the exact balance-delta check.

```bash
export PRIVATE_KEY=0x...
export AUTHORIZED_CALLER=0x...
forge script script/DeployTopupCallback.s.sol:DeployTopupCallback \
  --rpc-url goat_testnet3 --broadcast
```

The script accepts a zero `AUTHORIZED_CALLER`, but that leaves every callback
entrypoint unusable until the owner authorizes a caller.

## Configured Foundry Networks

| Alias | Chain ID | Purpose |
| --- | ---: | --- |
| `bsc_testnet` | `97` | BSC Testnet |
| `goat_testnet3` | `48816` | GOAT Testnet3 |
| `goat_mainnet` | `2345` | GOAT mainnet |
| `sepolia` | `11155111` | Ethereum Sepolia |
| `metis_sepolia` | `59902` | Metis Sepolia |

RPC and verifier URLs are defined in `foundry.toml`. Explorer API keys are only
needed when verification is requested.

## Deployment Safety

- Keep deployment keys in `.env.deploy` or another local secret store.
- Authorize only the operator caller supplied for the target environment.
- Use the ERC1967 proxy address for configuration and monitoring.
- Do not copy database SQL or callback ABIs from old docs; submit the proxy and
  let the current operator workflow register the supported ABI.
- Review and test upgrades against the existing proxy storage before broadcast.
- These scripts broadcast irreversible transactions when `--broadcast` is
  present.
