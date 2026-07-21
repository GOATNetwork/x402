# GOAT Flow Developer Quick Start

> A quick-start guide for developers.  
> The goal is to help you complete a basic x402 integration and run your first payment flow in the shortest possible time.

---

## Who This Guide Is For

This guide is for:

- developers who want to start integrating x402 quickly
- teams that already have a Merchant Account and API credentials
- projects that want to get a minimal payment flow working before expanding further

---

## What You Need Before You Start

Before getting started, make sure you already have:

- a created Merchant Account
- a configured Receiving Address
- generated API Key and API Secret
- a working test or development environment
- a chosen payment mode: DIRECT or DELEGATE

For a fixed DIRECT QuickPay product opened through Hosted Checkout, API credentials
are not required in the browser. Dynamic DIRECT and every DELEGATE Checkout Session
still require credentials on the merchant backend.

If these prerequisites are not ready yet, read:

- **x402 Onboarding Guide**
- **Merchant Guide**

---

## Quick Start Flow

The recommended quick-start flow is:

1. Get the x402 SDK or demo project
2. Configure API credentials
3. Create your first order
4. Initiate a payment
5. Query order status
6. Retrieve proof (if applicable)
7. Validate everything in the test environment

---

# Step 01 — Get the SDK / Project Resources

There are currently two main paths:

## Option 1: Get Started Directly from GitHub

Recommended entry point:

- **x402 GitHub Repo**  
  https://github.com/GOATNetwork/x402

From the repository, you can access:

- SDK packages
- example projects
- API documentation
- demos
- developer-focused docs

## Option 2: Integrate Through an Agent

If your team uses an agent-assisted payment flow, start from the merchant's QuickPay agent document:

```text
GET https://flow-api.goat.network/quickpay/{merchant_id}/agent.md
```

The agent document points to the matching `manifest.json` and public QuickPay session endpoints.

## Install the Core SDKs

```bash
# Backend order creation and polling
npm install goatflow-sdk-server

# Frontend wallet payment helper
npm install goatflow-sdk ethers

# Agent / CLI QuickPay payer
npm install goatflow-quickpay

# Hosted browser checkout
npm install goatflow-checkout
```

---

## Fastest Browser Path: Hosted Checkout

For a fixed, server-priced DIRECT product:

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })

payButton.addEventListener('click', () => {
  goat.open({
    merchant: 'merchant_123',
    productKey: 'mug',
    onSuccess: () => {
      // UX only; fulfill from the webhook or trusted backend status.
    },
  })
})
```

For a dynamic DIRECT amount or any DELEGATE checkout, use the server SDK's
`createCheckoutSession(...)` on your backend and pass the returned opaque
`checkoutId` to `goat.open({ checkoutId })`. See
[Hosted Checkout](x402-checkout.md).

Use the remaining steps when you need the lower-level, build-your-own order and
wallet flow.

---

# Step 02 — Configure API Credentials

Configure the following values in your backend project:

- API URL
- API Key
- API Secret

```bash
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
```

## Important Notes

- `API Secret` must only be stored on the server side
- test and production credentials must be kept separate
- do not expose key / secret values in frontend code or public repositories

---

# Step 03 — Create Your First Order

The first integration step is usually handled on the backend.

When creating an order, confirm the following:

- chain
- token
- amount
- payment mode (DIRECT / DELEGATE)
- callback / execution configuration (if applicable)

After order creation succeeds, the backend should return:

- `orderId`
- payment-related parameters
- the context needed for the selected payment mode

Minimal TypeScript backend example:

```typescript
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL ?? 'https://flow-api.goat.network',
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

const order = await client.createOrder({
  dappOrderId: `order_${Date.now()}`,
  chainId: 137,
  tokenSymbol: 'USDC',
  tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  fromAddress: '0xUserWalletAddress',
  amountWei: '10000000',
})

// Order creation returns an x402 HTTP 402 challenge under the hood.
// The SDK normalizes it into order.orderId, order.payToAddress, order.amountWei, and order.flow.
```

---

# Step 04 — Initiate Payment

After the frontend receives the order payload, it can trigger the payment flow for the user.

This step usually includes:

- launching the payment action
- wallet signature / user confirmation
- showing loading / success / error UI
- handling any callback-related pre-signature if required

---

# Step 05 — Query Order Status

After payment is initiated, the frontend or backend should be able to query order status for:

- payment progress tracking
- success / failure display
- fulfillment decisions

At minimum, your implementation should handle:

- waiting for payment
- payment in progress
- completed
- failed
- expired

---

# Step 06 — Retrieve Proof (If Applicable)

If your business logic requires payment proof, retrieve it after payment is completed.

Treat the response as a payment record: its `signature` field is an unsigned Keccak256 checksum over a subset of the payload fields (see the API reference for the exact list), not a cryptographic attestation. Verify `payload.tx_hash` on-chain when independent proof is required.

Typical proof use cases include:

- reconciliation
- audit trails
- fulfillment evidence
- dispute handling

---

# Step 07 — Validate in Test Environment

Before going live, it is recommended to validate at least the following:

- DIRECT flow works
- DELEGATE flow works (if applicable)
- receiving address is correct
- payment status updates correctly
- proof can be retrieved
- error handling behaves as expected
- fee balance is sufficient for order creation

### Test environment endpoints and gas

| Resource | GOAT Testnet3 (development) | GOAT Mainnet (production) |
| --- | --- | --- |
| Chain ID | `48816` | `2345` |
| RPC | `https://rpc.testnet3.goat.network` | `https://rpc.goat.network` |
| Explorer | `https://explorer.testnet3.goat.network` | `https://explorer.goat.network` |
| Merchant Portal | operator-provided per deployment | `https://x402-merchant.goat.network` |
| API base | operator-provided per deployment | `https://flow-api.goat.network` |

GOAT Network is a Bitcoin L2, so native gas is BTC:

- **Testnet3:** get BTC for gas from the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet); the minimum priority gas tip is `130000` wei.
- **Mainnet:** there is no faucet — fund the payer/deployer wallet with production native gas.

> The per-deployment Testnet3 API base and test token contracts are environment-specific — ask the GOAT Flow team for your Testnet3 API base and test token addresses. Full operator detail (chains, tokens, RPC, deploy steps) is in `ONBOARDING.md`.

---

## Common Questions

### 1. Order creation fails
Check first:

- whether the API key / secret is correct
- whether fee balance is sufficient
- whether chain / token / receiving configuration is correct

### 2. Order status does not update after payment
Check:

- whether payment was sent to the correct address
- whether token / chain / amount matches the order
- whether the required confirmations have been reached

### 3. DELEGATE callback does not complete successfully
Check:

- whether callback configuration is correct
- whether calldata is valid
- whether contract state matches expectations

---

## Related Documents

Recommended companion docs:

- **Hosted Checkout Guide**
- **x402 Onboarding Guide**
- **Merchant Guide**
- **x402 FAQ**
- **API Reference**
- **DIRECT vs DELEGATE Guide**

---

## One-Line Summary

If you are a developer, the fastest path to integrate x402 is:

**choose Hosted Checkout or a custom order flow → keep credentials on the backend
when required → confirm payment from webhook/status before fulfillment**

---

Contact email: x402support@goat.network
