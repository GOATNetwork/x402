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

---

## What Is DIRECT?

DIRECT mode means:

> **The user pays directly to the merchant address.**

This mode is simpler and better suited for lightweight payment scenarios.

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
- lower default fixed fee

### DIRECT Default Fee

- **The default fixed fee is typically $0.10 per order**

---

## What Is DELEGATE?

DELEGATE mode means:

> **Payment does not just complete fund transfer — it also supports post-payment on-chain execution logic.**

This mode is better suited for more advanced business flows.

### Good Fit For

- NFT minting
- in-game on-chain actions
- gas top-up flows
- agent-driven execution
- scenarios where payment success should immediately trigger callback or contract logic

### DELEGATE Characteristics

- more powerful payment flow
- supports callback / execution configuration
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
| User fund path | more direct | includes more complex system-assisted settlement |
| Callback / execution | usually not needed | supported |
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

---

## One-Line Summary

- **DIRECT = get paid**
- **DELEGATE = get paid + do something after payment**

---

Contact email: x402support@goat.network
