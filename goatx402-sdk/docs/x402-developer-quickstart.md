# GOAT x402 Developer Quick Start

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

If your team uses an Agent-assisted integration flow, a provided skills file can help the Agent guide the integration process.

---

# Step 02 — Configure API Credentials

Configure the following values in your backend project:

- API URL
- API Key
- API Secret

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

- **x402 Onboarding Guide**
- **Merchant Guide**
- **x402 FAQ**
- **API Reference**
- **DIRECT vs DELEGATE Guide**

---

## One-Line Summary

If you are a developer, the fastest path to integrate x402 is:

**get API credentials → create an order → initiate payment → query status → retrieve proof → complete testing**

---

Contact email: x402support@goat.network
