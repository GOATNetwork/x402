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

x402 integration in this repository supports **GOAT Network and other configured chains**.  
The exact set of supported chains depends on each merchant's GoatX402 Core configuration, including per-chain token, fee, wallet, and callback settings.

Based on current docs/examples, referenced networks include:

- GOAT Networks (`2345`)
- Ethereum (`1`)
- Polygon (`137`)
- Arbitrum (`42161`)
- BSC (`56`)
- Solana

## Development Documentation

- `DEVELOPER_FAST.md`
- `API.md`
