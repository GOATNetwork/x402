# GOAT Network x402

This repository is a reference integration project for **x402** in GOAT Network.

## What x402 Is Used For

x402 is a payment standard for crypto-native applications.  
It allows an app or API to request token payment in a structured way, so users can complete payment from their wallet and the service can verify settlement.

In short, GOAT Network x402 is used to make blockchain payments a standard part of application access, checkout, and service flows.

## What This Project Provides

This project demonstrates how to integrate x402 in practice, including:

- drop-in hosted checkout for DIRECT and DELEGATE merchants
- order creation and browser wallet payment workflows
- TypeScript and Go server SDK integration
- QuickPay payer/agent tooling and MPP receipt middleware
- callback/settlement contracts and a runnable demo

## Choose an Integration

| Need | Start here |
| --- | --- |
| Hosted browser checkout | [`docs/x402-checkout.md`](docs/x402-checkout.md) and `goatx402-checkout` |
| Custom wallet/order UI | `goatx402-sdk` + `goatx402-sdk-server-ts` or `goatx402-sdk-server-go` |
| Agent or CLI payment | `goatx402-quickpay` |
| Verify MPP receipts in an API | `goatx402-mpp-middleware-ts` or `goatx402-mpp-middleware-go` |
| Callback contracts | `goatx402-contract` |

Hosted Checkout has two server-authoritative forms under one Checkout Sessions
API: DIRECT uses a decimal `price`; DELEGATE uses either cross-chain decimal
`price` mode or the compatibility single-chain `fixed_amount_wei` mode. Fixed
DIRECT QuickPay products can also be opened without a merchant backend.

## Public Modules

| Module | Purpose |
| --- | --- |
| `goatx402-checkout` | Framework-free popup/tab/redirect browser SDK |
| `goatx402-sdk` | Low-level EVM wallet payment and MPP client primitives |
| `goatx402-sdk-server-ts` | HMAC-authenticated TypeScript server SDK |
| `goatx402-sdk-server-go` | HMAC-authenticated Go server SDK |
| `goatx402-quickpay` | Manifest-driven payer/agent library and CLI |
| `goatx402-mpp-middleware-ts` | Express/Fastify MPP receipt verification |
| `goatx402-mpp-middleware-go` | Go HTTP MPP receipt verification |
| `goatx402-contract` | MerchantCallback, TopupCallback, and test tokens |
| `goatx402-demo` | Hosted Checkout plus advanced Classic/MPP examples |

## Chain Support

GOAT x402 supports configured **EVM mainnet** chains. Each merchant still needs per-chain token, fee, receiving-address, and callback-contract configuration before taking payments on a chain.

| Chain | Chain ID | DIRECT | DELEGATE |
| --- | ---: | --- | --- |
| Ethereum | `1` | Yes | Yes |
| Polygon | `137` | Yes | Yes |
| BSC | `56` | Yes | Yes |
| Arbitrum | `42161` | Yes | Yes |
| Optimism | `10` | Yes | Yes |
| Avalanche | `43114` | Yes | Yes |
| Base | `8453` | Yes | Yes |
| Berachain | `80094` | Yes | Yes |
| X Layer | `196` | Yes | Yes |
| GOAT | `2345` | Yes | Yes |
| Metis | `1088` | Yes | No |
| Tempo | `4217` | Yes | No |

DIRECT means the payer transfers ERC-20 tokens directly to the merchant receiving
address. DELEGATE means EIP-3009 or Permit2 settlement through the merchant
callback contract and TSS submission. The table describes merchant settlement
chains: Metis and Tempo are DIRECT-only there. Eligible cross-chain DELEGATE
source payments are derived from live token/TSS configuration.

## Development Documentation

Use `docs/README.md` as the canonical documentation hub.

Quick references:
- `DEVELOPER_FAST.md` - concise SDK/backend integration guide.
- `API.md` - Core API and HMAC authentication reference.
- `docs/x402-checkout.md` - hosted Checkout Sessions and browser SDK.
- `docs/README.md` - structured public docs index, including QuickPay, Checkout, MPP, and agent integration paths.

Production API base URL: `https://api.x402.goat.network`.

## License

No license has been declared for this repository as a whole. Unless and until
one is added, all rights are reserved by the project owners (GOAT Network);
contact them before any external use or redistribution. Exception: the four
published npm packages — `goatx402-sdk/`, `goatx402-sdk-server-ts/`,
`goatx402-quickpay/`, and `goatx402-checkout/` — are each MIT-licensed (see the
`LICENSE` file inside each package directory).
