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
2. **Step 02 — Configure Receiving Tokens & Addresses**
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
- Get access to continue with Payment Setup and API integration

## Merchant Registration Link

- **Merchant Registration**  
  https://x402-merchant.goat.network/

## Detailed Registration Guide

For a more detailed registration guide, please refer to:

- **GOAT x402 Merchant Guide (Chinese)**  
  https://github.com/GOATNetwork/x402/blob/main/docs/merchant-guide.md

## Information You Should Prepare in Advance

- Merchant name / project name
- Contact information
- Basic business description
- Your expected x402 use case (for example: API monetization, paid content, gaming payments, or agent payments)

## What You Should Have After This Step

- A created Merchant Account
- A merchant identity that can continue into configuration
- Access to proceed to the receiving setup step

---

# Step 02 — Configure Receiving Tokens & Addresses

## Goal

Complete **Payment Setup → Receiving Tokens & Addresses** and define how payments should be received.

## Why This Step Matters

Before integration and launch, you must clearly define:

- where funds should be received
- which EVM chain should be used
- which token should be accepted
- whether your payment flow requires more advanced post-payment execution

## What This Step Usually Includes

### 1. Configure EVM Chain
Confirm which EVM chain the merchant wants to use.

### 2. Configure Receiving Token
Confirm which token the merchant wants to accept, such as USDC or USDT.

### 3. Configure Receiving Tokens & Addresses
Set and verify the final receiving address.

### 4. Select Payment Mode
Choose the payment mode based on your business scenario:

- **DIRECT**: supports QuickPay hosted checkout with no API key, optional programmatic x402 with HMAC API keys, and Machine Payments Protocol (MPP) buyer flows without merchant API keys; the user pays directly to the merchant receiving address
- **DELEGATE**: programmatic x402 only; requires API keys and pays a TSS `payToAddress`; callback execution additionally requires an approved `MerchantCallback` contract authorized for the platform Bob caller

DIRECT and DELEGATE are mutually exclusive and fixed at merchant registration.

### 5. Configure Callback / Execution Logic (if applicable)
If your flow requires DELEGATE payment-triggered on-chain execution:

1. Deploy a `MerchantCallback` contract.
2. Get the platform Bob address from the platform operator/admin.
3. Call `setAuthorizedCaller(bob, true)` on the callback contract.
4. Submit the callback contract in the Merchant Portal for admin review.

## What You Should Have After This Step

- Confirmed receiving tokens and addresses
- A confirmed EVM chain and token
- A confirmed payment mode
- If using DELEGATE callback execution, an approved callback / execution configuration with Bob authorization

---

# Step 03 — Generate API Credentials

## Goal

Generate the API credentials required by your development team for HMAC-authenticated programmatic x402 and all DELEGATE integrations.

## What This Step Will Complete

- Generate API Key
- Generate API Secret
- Confirm how credentials are separated between test and production environments
- Deliver credentials securely to the backend team

## Why This Step Matters

API credentials are the foundation of backend integration. DIRECT QuickPay and MPP buyer challenge/verify flows do not require merchant API keys, but without valid credentials, programmatic integrations cannot:

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
- want to standardize integration using provided skill files

In this mode, a provided **skills file** helps the Agent understand:

- how to configure the x402 integration flow
- how to call the SDK
- how to create orders and payment flows
- how to prepare for testing and launch

This approach is better suited for teams that want a more standardized, AI-assisted, or workflow-driven integration process.

---

## No Matter Which Approach You Use, You Should Ultimately Complete

- install and configure the x402 SDK
- use the API credentials in your integration
- create orders
- initiate payments
- query payment status
- retrieve proof (if applicable)
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
- receiving tokens and addresses are correct
- DIRECT flow works
- DELEGATE flow works (if registered); callback execution works if configured and approved
- payment status updates correctly
- proof can be retrieved
- webhook notifications are received correctly (if applicable)

## B. Pre-Launch Checklist

### Merchant Setup
- [ ] Merchant account has been created
- [ ] Receiving tokens and addresses have been confirmed
- [ ] EVM chain / token has been confirmed
- [ ] Payment mode has been confirmed
- [ ] If using DELEGATE callback execution, `MerchantCallback` is deployed, Bob is authorized with `setAuthorizedCaller(bob, true)`, and admin review is complete

### Technical Integration
- [ ] API key / secret has been switched to the correct environment
- [ ] Frontend payment flow has been fully tested
- [ ] Backend order creation flow has been fully tested
- [ ] Status query and proof retrieval are working correctly
- [ ] Callback configuration, Bob authorization, and admin approval have been verified (if using DELEGATE callback execution)

### Documentation and Support
- [ ] Support email is ready
- [ ] FAQ / Guide is ready
- [ ] Documentation links are accessible
- [ ] Contact path is confirmed

### Launch Preparation
- [ ] The team has checked the **Fee Balance** page
- [ ] If needed, a Fee Top-up has been completed
- [ ] Test orders have been successfully completed
- [ ] Error messaging has been reviewed
- [ ] The support path is clearly defined

## Fee Items That Must Be Confirmed Before Launch

Before going live, make sure the merchant’s **Fee Balance** is sufficient to support order creation.

Please check the **Fee Balance** page before launch to confirm:

- the current Fee Balance is greater than 0
- the balance is sufficient for initial production usage
- any required Fee Top-up has already been completed

If the Fee Balance is insufficient, order creation will fail with an error such as **insufficient fee balance**.

## Direct and Delegate Pricing Model

x402 currently uses a **fixed-fee per order model**, not a percentage-based take rate.

### DIRECT
- The default fixed fee is typically **$0.10 per order**
- Best suited for QuickPay, simple payment flows, optional programmatic x402, and Machine Payments Protocol (MPP) buyer flows
- QuickPay hosted checkout does not require API keys
- Programmatic DIRECT requires HMAC API keys; MPP buyer challenge/verify flows do not
- The user pays directly to the merchant receiving address

### DELEGATE
- The default fixed fee is typically **$0.20 per order**
- The higher fee reflects Bob-submitted callback execution overhead
- Best suited for programmatic x402 flows that require post-payment on-chain execution
- Requires API keys and pays a TSS `payToAddress`; callback execution requires an approved `MerchantCallback` and Bob authorization

### Pricing Logic Summary
- Pricing is based on a **fixed fee per order**, not a percentage of payment amount
- **DIRECT typically defaults to $0.10 per order**
- **DELEGATE typically defaults to $0.20 per order**
- Fees may vary by chain or configuration, but the default documentation baseline uses these two tiers
- Fees are deducted from the merchant’s **Fee Balance**
- Fee balance is checked when an order is created
- If the order completes successfully, the fee is consumed
- If the order expires or is canceled, the corresponding fee is refunded to the Fee Balance

## What You Should Have After This Step

- test environment validation has been completed
- production configuration is ready
- documentation and support paths are ready
- your x402 payment flow is ready to go live

---

# Related Documents

It is recommended to read this guide together with:

- **Merchant Registration / Merchant Guide (Chinese)**  
  https://github.com/GOATNetwork/x402/blob/main/docs/merchant-guide.md
- **x402 FAQ (English)**
- **Why x402 (English)**
- **Merchant Guide (English)**
- **Developer Quick Start**
- **API Reference**

---

# One-Line Summary

The GOAT x402 onboarding path can be summarized as:

**register merchant → configure receiving tokens & addresses → generate credentials → integrate SDK → test and go live**

Once all five steps are complete, you have the core requirements needed to launch x402 payment capability.

---

Contact email: x402support@goat.network
