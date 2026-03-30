---
name: x402-dapp-integration
description: Use this skill when integrating x402 payments into an existing Web DApp from a local folder or Git repository. Apply it when a user wants Codex to prepare merchant credentials, copy the app into a safe working directory, add backend and frontend x402 flows, run local validation, and produce runnable integration documentation without assuming any specific business domain.
---

# X402 DApp Integration

## Overview

This skill converts an existing Web DApp into an x402-enabled DApp with a reusable merchant-friendly workflow. It is designed for generic products, so do not assume any specific business domain, feature naming, or protected-content model unless the user explicitly provides one.

## When To Use

Use this skill when the user wants to:

- integrate x402 into an existing Web DApp
- work from a local source directory or a Git repository URL
- preserve the original business flow and insert a paywall only around paid or protected actions
- support merchant credentials securely on the backend
- generate local run instructions, validation results, and handoff documentation

Do not use this skill for:

- building a brand-new DApp from scratch unless the user explicitly asks for that
- rewriting the product's business logic beyond the minimum payment-gating changes
- exposing merchant secrets to the frontend

## Required Inputs

Collect or infer these inputs before making changes:

- `APP_SOURCE`: local project path or Git repository URL
- `WORKDIR_PARENT`: parent folder for the generated integration project
- `PROJECT_NAME`: name of the new working copy
- `ENV_FILE_PATH`: merchant environment file path
- `PRIVATE_KEY_STORE_PATH`: local storage path for the generated test wallet
- `X402_REPO`: x402 repository URL
- `MIN_PAY_AMOUNT`: minimum accepted stablecoin amount
- `MIN_PAY_TOKENS`: allowed payment tokens, usually `USDT,USDC`
- `BASE_PRICE_BTC`: BTC anchor price unit, such as `0.00001`
- `BINANCE_PRICE_URL`: source of `BTCUSDC`
- `QUOTE_TTL_SECONDS`
- `PRICE_CACHE_SECONDS`

Only read these merchant fields from `ENV_FILE_PATH`:

- `GOATX402_MERCHANT_ID`
- `GOATX402_API_URL`
- `GOATX402_API_KEY`
- `GOATX402_API_SECRET`

If any required merchant field is missing, stop immediately and return the missing-field error.

## Workflow

### 1. Prepare Merchant Inputs

Before any code change, validate that:

- merchant credentials exist and are readable from the provided env file
- the target working directory is separate from the original source
- a private-key storage path is available
- supported chains, tokens, and minimum payment requirements are explicit

Never place merchant credentials in frontend code or build artifacts.

### 2. Copy the DApp Into a Safe Working Directory

Detect whether `APP_SOURCE` is:

- a local directory
- a Git repository URL

Then:

- copy or clone it into `WORKDIR_PARENT/PROJECT_NAME`
- leave the original source untouched
- inspect the copied project to detect the frontend framework and whether a backend already exists
- create a backend only if the project does not already have one

### 3. Build and Install x402 SDKs

Clone `X402_REPO` into a temporary directory and build:

- `goatx402-sdk`
- `goatx402-sdk-server-ts`

Install both packages into the working project from local paths. Verify that each package has a valid `dist` build before continuing.

### 4. Add Backend x402 Capabilities

Use the following `/api/x402/*` routes as the **recommended integration interface convention** for this skill. Teams may adapt the route structure to match their existing backend architecture, as long as the payment flow, validation rules, and backend responsibilities remain consistent.

Recommended x402 backend APIs:

- `GET /api/health`
- `GET /api/x402/config`
- `GET /api/x402/quote`
- `POST /api/x402/session`
- `POST /api/x402/order`
- `POST /api/x402/order/:id/signature`
- `GET /api/x402/order/:id`
- `POST /api/x402/reveal`

Backend rules:

- enforce token allowlist
- enforce chain allowlist
- enforce minimum payment amount
- calculate pricing on the backend only
- derive `amountWei` from token decimals using ceiling
- reject expired quotes
- reject mismatched order amounts
- treat frontend-submitted amount as reference only
- never log private keys, API secrets, or full auth headers

### 5. Apply Generic Pricing Logic

Execute pricing on the backend with this model:

- fetch `BTCUSDC` from `BINANCE_PRICE_URL`
- compute `converted = BASE_PRICE_BTC * btcUsdcPrice`
- compute `finalAmount = max(converted, MIN_PAY_AMOUNT)`
- use the same `finalAmount` across all supported chains for stablecoins
- cache source price for `PRICE_CACHE_SECONDS`
- set quote expiry to `QUOTE_TTL_SECONDS`

Each quote should include:

- `quoteId`
- `basePriceBtc`
- `btcUsdcPrice`
- `finalAmount`
- `amountWei`
- `token`
- `chainId`
- `expiresAt`

If the live Binance request fails:

- use a still-valid cached price if available
- otherwise return `503` and reject order creation

### 6. Add Frontend Payment Flow

Insert a payment gate before protected or paid content without breaking the existing user flow.

Implement the state machine:

- `idle -> session_created -> quote_ready -> order_created -> paying -> confirming -> paid -> unlocked`

Frontend payment flow:

1. create session
2. request quote
3. create order
4. initiate wallet payment with `goatx402-sdk`
5. poll order status
6. call reveal after successful confirmation

Frontend requirements:

- block submission when the visible amount is below the minimum threshold
- auto-refresh expired quotes
- display BTC anchor, stablecoin quote, price source, and quote expiry

### 7. Generate Test Wallet and Handle Faucet Setup

Generate a local EVM test wallet and store it at `PRIVATE_KEY_STORE_PATH`.

Rules:

- store the private key in a local file only
- never print the private key in plain text
- set file permission to `600`
- add the private-key file to `.gitignore`

If faucet calls require captcha fields and they are not provided, return exactly:

`captcha_id/captcha_code required from user`

### 8. Run Local Validation

Start the local backend and frontend, then validate:

- health endpoint works
- config endpoint works
- quote endpoint returns `finalAmount`, `amountWei`, and `expiresAt`
- an order below the minimum amount fails
- a minimum-boundary order behaves correctly based on the quote
- a correctly priced order can be created
- protected content remains locked until payment is confirmed

If full on-chain payment cannot be completed, report the exact blocker instead of claiming success.

### 9. Deliver Final Outputs

Produce:

- modified file list
- executed command list
- acceptance results
- unfinished items and blockers
- next-step suggestions
- a runnable integration guide in the new project root

The integration guide should include:

- environment variables and where they are read
- startup steps
- API definitions with examples
- frontend payment state machine
- backend pricing rules
- minimum amount rules
- faucet workflow
- troubleshooting
- a short demo script

## Guardrails

- Do not assume the DApp domain.
- Do not rename existing business APIs unless required by the fixed x402 endpoints.
- Do not expose merchant credentials to the frontend.
- Do not modify the original project in place.
- Do not remove existing product behavior unless it conflicts with required payment gating.
- Do not claim full payment success unless the order reaches confirmed status and reveal succeeds.

## Example Trigger Prompts

- "Use this skill to add x402 to my existing DApp from this Git repo."
- "Integrate x402 into the app at this local path and keep the original project untouched."
- "Wire a generic x402 paywall into my current frontend and backend, then give me local test steps."
