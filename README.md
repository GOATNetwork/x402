# GOAT Network x402

This repository is a reference integration project for **x402** in GOAT Network.

## What x402 Is Used For

x402 is a payment standard for crypto-native applications.  
It allows an app or API to request token payment in a structured way, so users can complete payment from their wallet and the service can verify settlement.

In short, GOAT Network x402 is used to make blockchain payments a standard part of application access, checkout, and service flows.

## What This Project Provides

This project demonstrates how to integrate x402 in practice, including:

- order creation and payment workflow
- client and server integration patterns
- callback/settlement-related implementation examples

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

DIRECT means the payer transfers ERC-20 tokens directly to the merchant receiving address. DELEGATE means EIP-3009 or Permit2 settlement through the merchant callback contract and TSS submission; Metis and Tempo are DIRECT-only.

## Development Documentation

Use `docs/README.md` as the canonical documentation hub.

Quick references:
- `DEVELOPER_FAST.md` - concise SDK/backend integration guide.
- `API.md` - Core API and HMAC authentication reference.
- `docs/README.md` - structured public docs index, including QuickPay, QuickPay Products, MPP, and agent integration paths.

Production API base URL: `https://api.x402.goat.network`.
