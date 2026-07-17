# DIRECT vs DELEGATE

> A guide to the two payment modes currently supported by GOAT Flow.

---

## Why Are There Two Modes?

Different business scenarios require different kinds of payment flows.

Some scenarios only need to **collect payment**.
Others require the system to **continue executing on-chain logic after payment succeeds**.

That is why GOAT Flow supports two modes:

- **DIRECT**
- **DELEGATE**

---

## What Is DIRECT?

DIRECT mode means:

> **The user pays directly to the merchant address.**

This mode is simpler and better suited for lightweight payment scenarios. The payer sends an ERC-20 transfer on the selected EVM chain to the merchant's configured receiving address; the x402 watcher matches that transfer to the order. There is no TSS payout step and no callback contract in the fund path.

### Good Fit For

- simple product purchases
- paid content
- API monetization
- tips / donations
- payment flows that do not require complex on-chain execution

### DIRECT Characteristics

- simpler integration path
- funds go directly to the merchant address
- usually does not require complex callback execution
- available on all supported EVM mainnets
- lower per-chain configured fee

### DIRECT Default Fee

- **The default configuration is typically $0.10 per order, but fees are chain/admin-configured**

---

## What Is DELEGATE?

DELEGATE mode means:

> **Payment does not just complete fund transfer — it also supports post-payment on-chain execution logic.**

This mode is better suited for more advanced business flows. The merchant still
configures one EVM callback/settlement chain, and its receiving tokens plus approved
callback contract must agree on that chain. A DELEGATE order may, however, accept
payment on an eligible source chain and settle/call back on that fixed merchant
chain. Orders use EIP-3009 `receiveWithAuthorization` or Permit2
`SignatureTransfer`, TSS co-signing, and SubmitMonitor submission.

### Good Fit For

- NFT minting
- in-game on-chain actions
- gas top-up flows
- agent-driven execution
- scenarios where payment success should immediately trigger callback or contract logic

### DELEGATE Characteristics

- more powerful payment flow
- supports callback / execution configuration through an approved merchant callback contract
- uses EIP-3009 or Permit2 authorization plus TSS-assisted submission
- requires one EVM callback/settlement chain per DELEGATE merchant configuration
- can expose eligible source-chain/token choices in cross-chain Hosted Checkout
- cannot use Metis or Tempo as the merchant callback/settlement chain in the current matrix
- better for payment + execution scenarios
- higher per-chain configured fee

### DELEGATE Default Fee

- **The default configuration is typically $0.20 per order, but fees are chain/admin-configured**

---

## Chain Availability

| Chain | Chain ID | DIRECT | DELEGATE | Explorer |
| --- | --- | --- | --- | --- |
| Ethereum | `1` | Yes | Yes | `etherscan.io` |
| Polygon | `137` | Yes | Yes | `polygonscan.com` |
| BSC | `56` | Yes | Yes | `bscscan.com` |
| Arbitrum | `42161` | Yes | Yes | `arbiscan.io` |
| Optimism | `10` | Yes | Yes | `optimistic.etherscan.io` |
| Avalanche | `43114` | Yes | Yes | `snowtrace.io` |
| Base | `8453` | Yes | Yes | `basescan.org` |
| Berachain | `80094` | Yes | Yes | `berascan.com` |
| X Layer | `196` | Yes | Yes | `web3.okx.com/explorer/x-layer/evm` |
| GOAT | `2345` | Yes | Yes | `explorer.goat.network` |
| Metis | `1088` | Yes | No | `andromeda-explorer.metis.io` |
| Tempo | `4217` | Yes | No | `explore.tempo.xyz` |

This matrix describes merchant receiving/callback-chain availability. DELEGATE
requires Permit2 or EIP-3009 support plus a reviewed callback contract on the
merchant settlement chain. Metis and Tempo should be configured as DIRECT
settlement chains. Cross-chain Hosted Checkout source candidates are derived from
live TSS/token configuration and are not implied by this static matrix.

---

## DIRECT vs DELEGATE Comparison

| Dimension | DIRECT | DELEGATE |
| --- | --- | --- |
| Core goal | collect payment | collect payment + execute logic |
| Complexity | low | medium / high |
| User fund path | user wallet -> merchant address | user -> source-chain TSS path -> merchant callback/settlement chain |
| Callback / execution | usually not needed | supported through approved callback contract |
| Chain scope | selected payment chain | one merchant callback chain; eligible source chain may differ |
| Best fit | simple payments | advanced on-chain business flows |
| Default fee | per-chain/admin-configured; often $0.10 / order | per-chain/admin-configured; often $0.20 / order |

---

## Pricing Model

GOAT Flow currently uses:

> **a fixed fee per order**

It does **not** use:

- percentage-based take rates
- GMV-based percentage fees

### Pricing Rules

- DIRECT: the default configured fee is often **$0.10 per order**
- DELEGATE: the default configured fee is often **$0.20 per order**
- actual fees are configured per chain by the platform/admin operator
- fees are paid from the merchant’s **fee balance**
- fee balance is checked when an order is created
- if an order completes successfully, the fee is consumed
- if an order expires or is canceled, the fee is refunded to the fee balance

---

## How to Choose

### Choose DIRECT if you need:

- faster integration
- a simpler payment flow
- a payment-only experience without downstream execution

### Choose DELEGATE if you need:

- post-payment on-chain execution
- callback / contract execution
- more advanced merchant workflows
- a combined payment + business action experience
- one configured EVM callback chain, optionally accepting eligible cross-chain source payments

---

## One-Line Summary

- **DIRECT = get paid**
- **DELEGATE = get paid + do something after payment**

---

Contact email: x402support@goat.network
