# GOAT Flow

This repository contains the public SDKs, examples, and supporting components
for integrating GOAT Flow x402 payments and its current MPP adapter on GOAT
Network.

## Current Public Product

The current public merchant path is **DIRECT**:

- the payer transfers an ERC-20 token to the merchant's configured receiving
  address;
- GOAT Flow software creates and tracks the order record; and
- the merchant confirms fulfillment from server-side order status or webhooks.

For the smallest integration, use a merchant-configured QuickPay product with
the hosted checkout. For a custom wallet and order UI, combine the browser SDK
with a server SDK so API credentials remain on the backend.

| Need | Start here |
| --- | --- |
| Hosted DIRECT checkout | [`docs/goat-flow-checkout.md`](docs/goat-flow-checkout.md) and `goatflow-checkout` |
| Custom wallet/order UI | `goatflow-sdk` plus `goatflow-sdk-server` or the Go server SDK |
| Agent or CLI payment | `goatflow-quickpay` |
| Merchant onboarding | [`docs/goat-flow-onboarding-guide.md`](docs/goat-flow-onboarding-guide.md) |
| Merchant operations | [`docs/merchant-guide.md`](docs/merchant-guide.md) |

Hosted checkout and QuickPay identify a product by merchant and product key.
Price, accepted tokens, receiving addresses, and other payment configuration
remain server-authoritative.

## Optional And Internal Components

The repository also contains components that are not required for the public
DIRECT merchant flow:

- [`MerchantCallback.sol`](goatx402-contract/src/MerchantCallback.sol) is a
  reference UUPS receiver for an optional, operator-provisioned callback
  transfer flow. Its
  `withCalldata` self-call has no selector allowlist; review the
  [security model](goatx402-contract/MERCHANT_CALLBACK.md#calldata-execution-semantics).
- [`TopupCallback.sol`](goatx402-contract/src/TopupCallback.sol) is dedicated
  to the internal `topup-service`; it is not a general merchant contract.
- [`USDC.sol`](goatx402-contract/src/USDC.sol) and
  [`USDT.sol`](goatx402-contract/src/USDT.sol) are configurable test tokens,
  not production token deployments.
- [MPP](https://mpp.dev/overview) is an independent open protocol, not a GOAT
  Flow protocol. The MPP clients and middleware in this repository implement
  GOAT Flow's current JSON-endpoint and signed-receipt profile, require an
  enabled Core environment, and have no checked-in interoperability test with
  official MPP SDKs.
- The demo contains config-gated advanced and MPP examples in addition to its
  default DIRECT checkout path.

Do not deploy a callback contract merely to use DIRECT checkout.

## Repository Map

| Module | Purpose | Distribution status |
| --- | --- | --- |
| [`goatflow-checkout`](goatx402-checkout/README.md) | Framework-free hosted-checkout browser SDK | Release-managed npm package |
| [`goatflow-sdk`](goatx402-sdk/README.md) | EVM buyer-wallet transfer and GOAT Flow MPP-profile client primitives | Release-managed npm package |
| [`goatflow-sdk-server`](goatx402-sdk-server-ts/README.md) | HMAC-authenticated TypeScript server SDK | Release-managed npm package |
| [`github.com/goatnetwork/goatflow-sdk-server`](goatx402-sdk-server-go/README.md) | HMAC-authenticated Go server SDK | Go module source |
| [`goatflow-quickpay`](goatx402-quickpay/README.md) | Manifest-driven payer/agent library and CLI | Release-managed npm package |
| [`@goatnetwork/mpp-middleware`](goatx402-mpp-middleware-ts/README.md) | Express/Fastify verification for the GOAT Flow MPP receipt extension | Source package; not in the npm release runbook |
| [`github.com/goatnetwork/goatflow-mpp-middleware-go`](goatx402-mpp-middleware-go/README.md) | Go HTTP verification for the GOAT Flow MPP receipt extension | Go module source |
| [`goatx402-contract`](goatx402-contract/README.md) | Optional/internal callbacks and local test tokens | Foundry project |
| [`goatx402-demo`](goatx402-demo/README.md) | DIRECT checkout plus optional advanced and MPP examples | Private local demo |

The npm release procedure covers exactly the four packages marked
"Release-managed npm package"; see [`RELEASING.md`](RELEASING.md).

## Chain And Token Configuration

Runtime chain and token availability is configuration-driven. A merchant should
use the chains and tokens returned by the merchant API or shown in the Merchant
Portal rather than relying on a hard-coded repository list.

### Supported Mainnet Chains

The operator-supplied mainnet documentation baseline, reviewed July 23, 2026,
is listed below. It is not encoded as one authoritative matrix in this
repository; runtime API and portal configuration remain controlling.

| Chain | Chain ID | Explorer |
| --- | ---: | --- |
| GOAT Network | `2345` | [explorer.goat.network](https://explorer.goat.network) |
| Ethereum | `1` | [etherscan.io](https://etherscan.io) |
| BSC | `56` | [bscscan.com](https://bscscan.com) |
| Arbitrum | `42161` | [arbiscan.io](https://arbiscan.io) |
| Optimism | `10` | [optimistic.etherscan.io](https://optimistic.etherscan.io) |
| Base | `8453` | [basescan.org](https://basescan.org) |
| Berachain | `80094` | [berascan.com](https://berascan.com) |
| X Layer | `196` | [X Layer Explorer](https://web3.okx.com/explorer/x-layer/evm) |
| Metis | `1088` | [andromeda-explorer.metis.io](https://andromeda-explorer.metis.io) |
| Tempo | `4217` | [explore.tempo.xyz](https://explore.tempo.xyz) |

This table is a documentation baseline, not a per-merchant entitlement. Confirm
the enabled chain/token pairs and receiving addresses in the target environment
before integration or launch.

For DIRECT, each enabled `(chain, token)` needs a valid merchant receiving
address and the deployment's associated service-fee/token configuration. Testnet aliases
inside `goatx402-contract/foundry.toml` are development conveniences and do not
describe the public production matrix.

## Development Documentation

Use [`docs/README.md`](docs/README.md) as the documentation hub.

Quick references:

- [Developer Quick Start](docs/goat-flow-developer-quickstart.md) - concise integration path.
- [API Reference](docs/goat-flow-api-reference.md) - Core API and HMAC authentication.
- [`docs/goat-flow-checkout.md`](docs/goat-flow-checkout.md) - hosted checkout.
- [`goatx402-demo/README.md`](goatx402-demo/README.md) - runnable demo modes.
- [`goatx402-contract/README.md`](goatx402-contract/README.md) - contract scope,
  tests, and deployment tooling.

The complete Mainnet and Testnet3 service-origin map is maintained in
[`docs/README.md`](docs/README.md#service-origins). The production API base
URL is `https://flow-api.goat.network`.

## License

No single repository-wide license has been declared. The four release-managed
npm packages, the two merchant-side MPP receipt middleware packages
(`goatx402-mpp-middleware-ts/`, `goatx402-mpp-middleware-go/`), and the
Solidity contracts package (`goatx402-contract/`) each include their own MIT
`LICENSE` file. Each package's MIT license covers that package only.
Directories without their own `LICENSE` file remain all-rights-reserved;
review the relevant module before reuse or redistribution.
