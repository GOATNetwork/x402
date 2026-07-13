# DIRECT vs DELEGATE

> A guide to the two payment modes currently supported by GOAT x402.

---

## Why Are There Two Modes?

Different business scenarios require different kinds of payment flows.

Some scenarios only need to **collect payment**.
Others require the system to **continue executing on-chain logic after payment succeeds**.

That is why GOAT x402 supports two modes:

- **DIRECT**
- **DELEGATE**

These modes are **mutually exclusive** and are fixed when the merchant account is registered.

---

## What Is DIRECT?

DIRECT mode means:

> **The user pays directly to the merchant receiving address.**

This mode is simpler and better suited for lightweight payment scenarios.

DIRECT supports two usage paths:

- **QuickPay hosted checkout**: no API key required
- **Programmatic x402**: HMAC API key required
- **Machine Payments Protocol (MPP) buyer flows**: no merchant API key required for buyer challenge/verify

### Good Fit For

- simple product purchases
- paid content
- API monetization
- tips / donations
- hosted QuickPay links
- payment flows that do not require MerchantCallback execution

### DIRECT Characteristics

- simpler integration path
- funds go directly to the merchant receiving address
- QuickPay does not require an API key
- programmatic x402 requires HMAC API keys
- MPP buyer challenge/verify flows do not require merchant API keys; route configuration is managed separately through merchant JWT-authenticated APIs
- does not use the platform Bob callback caller
- lower default fixed fee

### DIRECT Default Fee

- **The default fixed fee is typically $0.10 per order**

---

## What Is DELEGATE?

DELEGATE mode means:

> **Programmatic x402 payment can trigger merchant-owned on-chain execution through an approved MerchantCallback contract.**

This mode is better suited for more advanced business flows.

DELEGATE is **programmatic x402 only**. It requires:

- API keys

Callback execution additionally requires:

- a deployed `MerchantCallback` contract
- the platform Bob caller authorized with `setAuthorizedCaller(bob, true)`
- the Bob address supplied by the platform operator/admin
- the callback contract submitted in the Merchant Portal for admin review

In the payment flow, the buyer SDK transfers the ERC-20 payment to the TSS `payToAddress`. If callback calldata is present, the buyer also signs an EIP-712 callback authorization. The platform **Bob** caller submits that callback authorization to the merchant's approved callback contract.

### Good Fit For

- NFT minting
- in-game on-chain actions
- gas funding flows
- agent-driven execution
- scenarios where payment success should immediately trigger callback or contract logic

### DELEGATE Characteristics

- more powerful payment flow
- requires callback / execution configuration
- callback execution requires Bob caller authorization on the merchant callback contract
- better for payment + execution scenarios
- higher default fixed fee

### DELEGATE Default Fee

- **The default fixed fee is typically $0.20 per order**

---

## DIRECT vs DELEGATE Comparison

| Dimension | DIRECT | DELEGATE |
| --- | --- | --- |
| Core goal | collect payment | collect payment + execute logic |
| Complexity | low | medium / high |
| API key requirement | not required for QuickPay or MPP buyer challenge/verify; required for programmatic x402 | required |
| User fund path | direct to merchant receiving address | ERC-20 payment to TSS `payToAddress` |
| Callback / execution | not supported | optional through approved MerchantCallback when callback calldata is present |
| Bob authorization | not used | required when callback calldata is present |
| Best fit | simple payments | advanced on-chain business flows |
| Default fee | $0.10 / order | $0.20 / order |

---

## Pricing Model

GOAT x402 currently uses:

> **a fixed fee per order**

It does **not** use:

- percentage-based take rates
- GMV-based percentage fees

### Pricing Rules

- DIRECT: default fixed fee is typically **$0.10 per order**
- DELEGATE: default fixed fee is typically **$0.20 per order**
- fees are paid from the merchant’s **Fee Balance**
- Fee Balance is checked when an order is created
- if an order completes successfully, the fee is consumed
- if an order expires or is canceled, the fee is refunded to the Fee Balance

---

## How to Choose

### Choose DIRECT if you need:

- faster integration
- a simpler payment flow
- a payment-only experience without downstream execution
- QuickPay hosted checkout without API keys
- optional programmatic x402 or Machine Payments Protocol (MPP) buyer flows

### Choose DELEGATE if you need:

- post-payment on-chain execution
- MerchantCallback / contract execution
- more advanced merchant workflows
- a combined payment + business action experience
- API-key-based programmatic x402 with optional Bob-authorized callback submission

---

## One-Line Summary

- **DIRECT = get paid**
- **DELEGATE = get paid + do something after payment**

---

Contact email: x402support@goat.network
