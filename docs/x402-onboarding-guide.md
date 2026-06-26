# GOAT x402 Onboarding Guide

> An onboarding guide for Merchants, Builders, and Operations / PM teams.  
> This document walks you through the full process of getting started with GOAT x402, from merchant registration and receiving setup to API credentials, SDK integration, testing, and launch.

---

## Who This Guide Is For

This guide is intended for the following audiences:

- **Merchant / business owner**: to complete merchant registration, confirm receiving setup, and drive launch readiness
- **Builder / developer**: to complete API integration, SDK setup, testing, and implementation
- **Operations / PM**: to understand the full workflow, coordinate dependencies, and confirm launch readiness

---

## Overall Onboarding Flow

The recommended onboarding flow for GOAT x402 is:

1. **Step 01 — Register Merchant Account**
2. **Step 02 — Configure Receiving Address**
3. **Step 03 — Generate API Credentials**
4. **Step 04 — Integrate x402 SDK**
5. **Step 05 — Test & Go Live**

If this is your first integration, it is recommended to complete these steps in order.

---

# Step 01 — Register Merchant Account

## Goal

Create your merchant account and obtain access for the next stages of setup and integration.

## What You Will Complete

- Create a Merchant Account
- Fill in the required basic information
- Confirm merchant identity details
- Get access to continue with receiving setup and API integration

## Merchant Registration Link

- **Merchant Registration**  
  https://x402-merchant.goat.network/

## Detailed Registration Guide

For a more detailed registration guide, please refer to:

- [GOAT x402 Merchant Guide (English)](./merchant-guide.md)

## Information You Should Prepare in Advance

- Merchant name / project name
- Contact information
- Basic business description
- Your expected x402 use case (for example: API monetization, paid content, gaming payments, or agent payments)

## What You Should Have After This Step

- A created Merchant Account
- A merchant identity that can continue into configuration
- Access to proceed to the receiving setup step
- A clear account-security plan, including whether each user should enable self-service 2FA in Settings

---

# Step 02 — Configure Receiving Address

## Goal

Complete the merchant receiving setup and define how settlement should be received.

## Why This Step Matters

Before integration and launch, you must clearly define:

- where funds should be received
- which chain should be used for settlement
- which token should be used for settlement
- whether your payment flow requires more advanced post-payment execution

## What This Step Usually Includes

### 1. Configure Settlement Chain
Confirm which chain the merchant wants to receive settlement on.

### 2. Configure Settlement Token
Confirm which token the merchant wants to receive, such as USDC or USDT.

### 3. Configure Receiving Address
Set and verify the final receiving address.

### 4. Select Payment Mode
Choose the payment mode based on your business scenario:

- **DIRECT**: the user pays directly to the merchant address
- **DELEGATE**: same-chain EVM settlement using EIP-3009 or Permit2, TSS submission, and an approved callback contract

### 5. Configure Callback / Execution Logic (if applicable)
If your flow requires payment-triggered on-chain execution, complete the related callback or execution configuration here.

If your flow needs public payment links or agent-native payments, use `DIRECT` and plan to enable QuickPay after receiving addresses are configured.

## What You Should Have After This Step

- A confirmed receiving address
- A confirmed settlement chain and token
- A confirmed payment mode
- If applicable, a registered callback / execution configuration

---

# Step 03 — Generate API Credentials

## Goal

Generate the API credentials required by your development team to begin integration.

## What This Step Will Complete

- Generate API Key
- Generate API Secret
- Confirm how credentials are separated between test and production environments
- Deliver credentials securely to the backend team

## Why This Step Matters

API credentials are the foundation of backend integration. Without valid credentials, you cannot:

- create orders
- query payment status
- retrieve payment proof
- call merchant-related APIs

## Usage Requirements

### 1. Separate Environments
Keep test and production credentials separate. Do not mix them.

### 2. API Secret Is Server-Side Only
The `API Secret` must only be stored on the backend. It must never be exposed in frontend code or public repositories.

### 3. Secure Storage
It is recommended that your development team store credentials in environment variables or a secure secret manager.

## What You Should Have After This Step

- API URL
- API Key
- API Secret
- Clear guidance on test vs production environments

Production API integrations should use `https://api.x402.goat.network`.

---

# Step 04 — Integrate x402 SDK

## Goal

Choose the integration path that best fits your team and complete the x402 SDK integration.

## The Two Supported Integration Approaches

### Option 1: Integrate Directly from the x402 GitHub Repository

This approach is suitable for teams that:

- have a development team that can work directly with code and technical documentation
- want to start from the SDK, sample projects, and API references
- prefer to pull the latest resources directly from GitHub

Developers can use the GitHub repository to access:

- the x402 SDK
- integration documentation
- API documentation
- demo examples
- related project code

Recommended entry point:

- **x402 GitHub Repo**  
  https://github.com/GOATNetwork/x402

If your team is already comfortable with standard frontend and backend integration, this is the most direct way to get started.

---

### Option 2: Integrate Through an Agent

This approach is suitable for teams that:

- want to reduce manual integration overhead
- want an Agent to assist with the integration process
- want to standardize payment execution through the merchant's public QuickPay agent surface

In this mode, the merchant's QuickPay **agent guide** is the concrete agent-readable file:

```text
https://api.x402.goat.network/quickpay/<merchant_id>/agent.md
```

The same merchant also exposes a machine-readable manifest:

```text
https://api.x402.goat.network/quickpay/<merchant_id>/manifest.json
```

The QuickPay `agent.md` helps the Agent understand:

- which public endpoints are safe to call
- which tokens and chains are offered
- how to create and poll QuickPay x402 sessions
- how to pay custom amounts with `goatx402-quickpay`
- which predefined Products are available through `product_key`, when configured

This approach is better suited for teams that want a more standardized, AI-assisted, or workflow-driven integration process.

---

## No Matter Which Approach You Use, You Should Ultimately Complete

- install and configure the x402 SDK
- use the API credentials in your integration
- create orders
- initiate payments
- query payment status
- retrieve proof for confirmed orders
- enable QuickPay and Products when public payment links or agent payments are needed
- complete test environment validation
- complete production launch preparation

## What You Should Have After This Step

- a usable x402 SDK integration capability
- a working baseline payment flow
- readiness to move into testing and go-live

---

# Step 05 — Test & Go Live

## Goal

Complete testing, validation, and launch checks before going live.

## A. Test Environment Validation

It is recommended to verify the following in the test environment:

- merchant configuration is correct
- API credentials are valid
- receiving address is correct
- DIRECT flow works
- DELEGATE flow works (if applicable)
- payment status updates correctly
- proof can be retrieved
- webhook notifications are received correctly (if applicable)

## B. Pre-Launch Checklist

### Merchant Setup
- [ ] Merchant account has been created
- [ ] Receiving address has been confirmed
- [ ] Settlement chain / token has been confirmed
- [ ] Payment mode has been confirmed
- [ ] Merchant users have reviewed 2FA and recovery-code setup

### Technical Integration
- [ ] API key / secret has been switched to the correct environment
- [ ] Frontend payment flow has been fully tested
- [ ] Backend order creation flow has been fully tested
- [ ] Status query and proof retrieval are working correctly
- [ ] Callback configuration has been verified (if applicable)
- [ ] QuickPay `agent.md` and `manifest.json` have been tested if agent payments are in scope
- [ ] QuickPay Products have been created if fixed-price product checkout is in scope

### Documentation and Support
- [ ] Support email is ready
- [ ] FAQ / Guide is ready
- [ ] Documentation links are accessible
- [ ] Contact path is confirmed

### Launch Preparation
- [ ] The team has checked the **fee balance** in the Dashboard
- [ ] If needed, the fee balance has been topped up from the Topup page
- [ ] Test orders have been successfully completed
- [ ] Error messaging has been reviewed
- [ ] The support path is clearly defined

## Fee Items That Must Be Confirmed Before Launch

Before going live, make sure the merchant’s **fee balance** is sufficient to support order creation.

Please check the **Dashboard** before launch to confirm:

- the current fee balance is greater than 0
- the balance is sufficient for initial production usage
- any required top-up has already been completed

If the fee balance is insufficient, order creation will fail with an error such as **insufficient fee balance**.

## Direct and Delegate Pricing Model

x402 currently uses a **fixed-fee per order model**, not a percentage-based take rate. Fees are chain/admin configured; the values below are the documentation baseline and should be checked against the active fee configuration before launch.

### DIRECT
- The default fixed fee is typically **$0.10 per order**
- Best suited for simple payment flows
- The user typically pays directly to the merchant address

### DELEGATE
- The default fixed fee is typically **$0.20 per order**
- The higher fee reflects additional settlement, payout gas, and execution overhead
- Best suited for flows that require post-payment on-chain execution

### Pricing Logic Summary
- Pricing is based on a **fixed fee per order**, not a percentage of payment amount
- **DIRECT typically defaults to $0.10 per order**
- **DELEGATE typically defaults to $0.20 per order**
- Fees may vary by chain or configuration, but the default documentation baseline uses these two tiers
- Fees are deducted from the merchant’s **fee balance**
- Fee balance is checked when an order is created
- If the order completes successfully, the fee is consumed
- If the order expires or is canceled, the corresponding fee is refunded to the fee balance

## What You Should Have After This Step

- test environment validation has been completed
- production configuration is ready
- documentation and support paths are ready
- your x402 payment flow is ready to go live

---

# Related Documents

It is recommended to read this guide together with:

- [Merchant Guide](./merchant-guide.md)
- [x402 FAQ](./x402-faq.md)
- [Why x402](./why-x402.md)
- [Developer Quick Start](./x402-developer-quickstart.md)
- [API Reference](./x402-api-reference.md)
- [Agent Integration Guide](./x402-agent-integration-guide.md)
- [DApp Integration Skill](./x402-dapp-integration-prompts/SKILL.md)

---

# One-Line Summary

The GOAT x402 onboarding path can be summarized as:

**register merchant → configure receiving → generate credentials → integrate SDK → test and go live**

Once all five steps are complete, you have the core requirements needed to launch x402 payment capability.

---

Contact email: x402support@goat.network
