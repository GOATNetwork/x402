# x402 Onboarding Guide

This is the admin/operator + developer runbook. Merchant-facing onboarding lives in docs/x402-onboarding-guide.md and docs/merchant-guide.md.

A complete admin/operator and developer runbook for GoatX402 payments — covering **admin setup**, **developer integration**, and **end-to-end testing**. Includes both Dashboard and CLI workflows.

---

## Table of Contents

1. [Roles Overview](#1-roles-overview)
2. [Admin: Merchant Setup](#2-admin-merchant-setup)
3. [Developer: Project Setup](#3-developer-project-setup)
4. [Developer: Callback Contract Deployment](#4-developer-callback-contract-deployment)
5. [Admin: Finalize Configuration](#5-admin-finalize-configuration)
6. [Developer: Run the Demo](#6-developer-run-the-demo)
7. [User: Making a Payment (Browser)](#7-user-making-a-payment-browser)
8. [Developer: API-Only Test Payment](#8-developer-api-only-test-payment)
9. [Full Test Log (Real Example)](#9-full-test-log-real-example)
10. [Go-Live Checklist](#10-go-live-checklist)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Roles Overview

| Role | Responsibilities |
|---|---|
| **GoatX402 Admin** | Create merchant, configure chains/tokens, set up fee balance, register callback contracts |
| **Developer (Merchant)** | Integrate SDK, deploy callback contract, run backend server, handle order lifecycle |
| **User (Payer)** | Connect wallet, approve payment, transfer tokens |

### Network Labels Used in This Runbook

Every network-specific value below is labeled as **Testnet3 (development)** or **Mainnet (production)**.

| Network label | Chain | Chain ID | RPC URL | Block explorer |
|---|---|---:|---|---|
| **Testnet3 (development)** | GOAT Testnet3 | `48816` | `https://rpc.testnet3.goat.network` | `https://explorer.testnet3.goat.network` |
| **Mainnet (production)** | GOAT mainnet | `2345` | `https://rpc.goat.network` | `https://explorer.goat.network` |

**Testnet3 (development) only:** faucet and gas-tip guidance applies only to GOAT Testnet3. Use the faucet at `https://bridge.testnet3.goat.network/faucet`; contract deployment examples use `--priority-gas-price 130000` and `--gas-price 1000000`.

**Mainnet (production):** there is no faucet. Use production native gas and the live gas policy for the selected chain; do not copy Testnet3 gas-tip values into production unless an operator explicitly confirms them.

Other production explorer labels from the supported-chain matrix include Metis `https://andromeda-explorer.metis.io`, Tempo `https://explore.tempo.xyz`, Base `https://basescan.org`, and X Layer `https://web3.okx.com/explorer/x-layer/evm`.

---

## 2. Admin: Merchant Setup

Admin setup can be done via the **Admin Dashboard** (web UI) or the **Admin API** (CLI/curl).

### Admin Auth Model

The legacy single `ADMIN_API_TOKEN` Bearer token was removed. Admin API access now uses multi-user session login with mandatory TOTP 2FA and per-route RBAC (`viewer`, `operator`, `super_admin`). Session tokens are stored server-side as `sha256(token)` and sent to clients as HttpOnly cookies (`__Host-admin_session` when secure cookies are enabled).

Non-onboarding admin routes require a fully authenticated session: `POST /admin/auth/login` creates a partial session, then enrolled admins complete `POST /admin/auth/totp/verify`. Non-interactive operator scripts use `ADMIN_TOTP_CODE` for that second factor, matching `scripts/m4/pilot_onboard.sh` and `scripts/m4/rollback.sh`. If login returns `next: "change_password"` or `next: "totp_enroll"`, complete that onboarding in the Admin Dashboard before using CLI admin operations.

### Prerequisites (CLI Session Auth)

```bash
# Mainnet (production)
export API_URL="https://api.x402.goat.network"

# Testnet3 (development)
# Use the operator-provided Testnet3/staging API base for that environment.
# Do not point Testnet3 chain examples at production unless that deployment is configured for Testnet3.
# export API_URL="<testnet3-api-base>"

export ADMIN_USERNAME="<admin-username>"
export ADMIN_PASSWORD="<admin-password>"
export ADMIN_TOTP_CODE="<totp-or-recovery-code>"

COOKIE_JAR="$(mktemp -t x402_admin_cookie.XXXXXX)"

# 1) Password login: creates a partial session cookie.
curl -sS -X POST -H "Content-Type: application/json" \
  -c "$COOKIE_JAR" \
  "$API_URL/admin/auth/login" \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" | jq .

# 2) Mandatory TOTP: upgrades the session to full auth.
curl -sS -X POST -H "Content-Type: application/json" \
  -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  "$API_URL/admin/auth/totp/verify" \
  -d "{\"code\":\"$ADMIN_TOTP_CODE\"}" | jq .
```

### 2a. Create Merchant

**Dashboard:** Go to Merchants → Create New Merchant

**CLI:**
```bash
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants" -d '{
  "merchant_id": "my_shop",
  "name": "My Shop",
  "receive_type": "DELEGATE",
  "generate_api_keys": true
}'
```

Response (save these immediately!):
```json
{
  "merchant_id": "my_shop",
  "api_key": "gHfeB7Il...",
  "api_secret": "rIeDeF0M...",
  "success": true
}
```

> ⚠️ **Save `api_key` and `api_secret` immediately.** The secret is only shown once. If lost, rotate keys with:
> ```bash
> curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants/my_shop/rotate-keys"
> ```

**Receive types:**
- `DIRECT` — user pays directly to merchant address
- `DELEGATE` — same-chain EVM settlement via EIP-3009 or Permit2, TSS submission, and callback contract

### 2b. Add Merchant Token Addresses

For each chain/token the merchant accepts, add a receiving address:

**CLI:**
```bash
# Testnet3 (development): add USDT on GOAT Testnet3.
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/addresses" -d '{
  "chain_id": 48816,
  "token_contract": "0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3",
  "symbol": "USDT",
  "address": "0xYourMerchantWallet"
}'

# Testnet3 (development): add USDC on GOAT Testnet3.
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/addresses" -d '{
  "chain_id": 48816,
  "token_contract": "0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1",
  "symbol": "USDC",
  "address": "0xYourMerchantWallet"
}'
```

**Token contracts by network:**

| Network label | Chain | Chain ID | Token | Contract / source |
|---|---|---:|---|---|
| **Testnet3 (development)** | GOAT Testnet3 | `48816` | USDT | `0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3` |
| **Testnet3 (development)** | GOAT Testnet3 | `48816` | USDC | `0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1` |
| **Testnet (development)** | BSC Testnet | `97` | USDT | `0x85181e18011d60ffebdf78fda202c2f5896eecae` |
| **Testnet (development)** | BSC Testnet | `97` | USDC | `0xa4b9550a5835ba669edd759cf82e6ca2d5e2c0a2` |
| **Testnet (development)** | Sepolia | `11155111` | USDT | `0xb7af9c6da7c7e7ec69d06466d326b9c2a2fbc0f8` |
| **Testnet (development)** | Sepolia | `11155111` | USDC | `0xff6981ac8f983914a9ea8d27b13c07d8d62c4a3b` |
| **Mainnet (production)** | GOAT mainnet | `2345` | USDC/USDT or configured token | Read the live production value from the Admin Dashboard or `GET /admin/tokens?chain_id=2345` after session auth. Do not reuse Testnet3 token contracts on mainnet. |

**Mainnet (production) token check:**
```bash
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  "$API_URL/admin/tokens?chain_id=2345" | jq .
```

### 2c. Top Up Fee Balance

Order creation deducts a fee (in USD) from the merchant's fee balance. **If the balance is zero, order creation will fail.**

**CLI:**
```bash
# Top up $100
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/fees/topup" -d '{
  "merchant_id": "my_shop",
  "amount_usd": 100,
  "description": "Initial topup"
}'

# Check balance
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/fees/balance/my_shop"
```

> ⚠️ This is a common blocker — if order creation returns `insufficient fee balance`, top up here.

### 2d. Verify Merchant Setup

**CLI:**
```bash
# Full merchant details
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants/my_shop" | jq .

# Public merchant info (no auth needed)
curl -s "$API_URL/merchants/my_shop" | jq .
```

At this point you should see:
- ✅ Merchant enabled
- ✅ Token addresses configured
- ✅ Fee balance > 0

---

## 3. Developer: Project Setup

### 3a. Clone and Install

```bash
git clone https://github.com/GOATNetwork/x402.git
cd x402

# Install demo app dependencies
cd goatx402-demo
pnpm install

# Install server SDK (repo directory is goatx402-sdk-server-ts;
# npm package name is goatx402-sdk-server)
cd ../goatx402-sdk-server-ts
pnpm install

cd ../goatx402-demo
```

### 3b. Configure Environment

Create `goatx402-demo/.env` with the credentials from the admin:

```bash
GOATX402_MERCHANT_ID=my_shop
# Mainnet (production)
GOATX402_API_URL=https://api.x402.goat.network
# Testnet3 (development): use the operator-provided Testnet3/staging API base.
# GOATX402_API_URL=<testnet3-api-base>
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret

PORT=3001
```

> ⚠️ **Never commit `.env` to version control.** It's already in `.gitignore`.

### 3c. Verify API Connection

```bash
# Start the backend
pnpm dev:server

# In another terminal:
curl http://localhost:3001/api/health
# → {"status":"ok"}

# Check merchant config — should show your chains and tokens
curl http://localhost:3001/api/config | jq .
```

If `chains` is empty, go back to [Step 2b](#2b-add-merchant-token-addresses).

---

## 4. Developer: Callback Contract Deployment

**Required for DELEGATE flow** (`ERC20_APPROVE_XFER` or `ERC20_3009`). Skip if using `DIRECT` flow.

### 4a. Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### 4b. Get Native Tokens for Gas

**Testnet3 (development):** Use the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet) to get BTC for gas.

**Mainnet (production):** No faucet. Fund the deployer with production native gas on GOAT mainnet (`chain_id=2345`) before deploying.

### 4c. Deploy the Contract

```bash
cd goatx402-contract

# Install Solidity dependencies
forge install

# Testnet3 (development): deploy on GOAT Testnet3 (chain_id=48816).
PRIVATE_KEY=<DEPLOYER_PRIVATE_KEY> forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url https://rpc.testnet3.goat.network \
  --broadcast \
  --priority-gas-price 130000 \
  --gas-price 1000000

# Mainnet (production): deploy on GOAT mainnet (chain_id=2345).
# Use production gas policy; do not copy Testnet3 faucet/gas-tip assumptions.
PRIVATE_KEY=<DEPLOYER_PRIVATE_KEY> forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url https://rpc.goat.network \
  --broadcast
```

> **Testnet3 (development) GOAT notes:**
> - Minimum gas tip: `130000` wei (transactions will be rejected below this)
> - Always set both `--priority-gas-price` and `--gas-price`
>
> **Mainnet (production) GOAT notes:**
> - Chain ID: `2345`
> - RPC: `https://rpc.goat.network`
> - Explorer: `https://explorer.goat.network`

### 4d. Note the Proxy Address

From the deployment output:
```
== Return ==
proxy: address <DEPLOYED_PROXY_ADDRESS>
```

---

## 5. Admin: Finalize Configuration

After the developer deploys the callback contract:

### 5a. Register Callback Contract

**CLI:**
```bash
# Testnet3 (development): callback contract on GOAT Testnet3 (chain_id=48816).
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/callback-contracts" -d '{
  "chain_id": 48816,
  "spent_address": "<DEPLOYED_PROXY_ADDRESS>",
  "eip712_name": "GoatX402 Pay Callback",
  "eip712_version": "1"
}'

# Mainnet (production): callback contract on GOAT mainnet (chain_id=2345).
# Replace spent_address with the proxy deployed on mainnet.
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/callback-contracts" -d '{
  "chain_id": 2345,
  "spent_address": "<MAINNET_CALLBACK_PROXY>",
  "eip712_name": "GoatX402 Pay Callback",
  "eip712_version": "1"
}'
```

`eip712_name` and `eip712_version` must match the deployed contract's EIP-712 domain. The repository deploy script initializes `MerchantCallback` with `GoatX402 Pay Callback` / `1` unless the owner later reinitializes the domain.

### 5b. Verify Complete Setup

**CLI:**
```bash
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants/my_shop" | jq .
```

The merchant should now have:
- [x] `enabled: true`
- [x] `addresses` — token addresses per chain
- [x] `callback_contracts` — callback contract per chain (DELEGATE only)
- [x] Fee balance > 0

---

## 6. Developer: Run the Demo

```bash
cd goatx402-demo
pnpm dev
```

This starts:
- **Frontend (Vite + React):** http://localhost:3000
- **Backend (Express):** http://localhost:3001

---

## 7. User: Making a Payment (Browser)

1. Open http://localhost:3000 in a browser with MetaMask
2. Click **Connect MetaMask**
3. Switch to the correct network: **Testnet3 (development)** GOAT Testnet3 or **Mainnet (production)** GOAT mainnet
4. Select a token (e.g., USDT) and enter an amount
5. Click **Pay**
6. If the flow requires a calldata signature, MetaMask will prompt for an EIP-712 signature first
7. MetaMask will prompt for the token transfer to the payment target (`payTo` in the x402 challenge; legacy demo responses may call it `payToAddress`)
8. Wait for the payment to be confirmed

**User prerequisites:**
- MetaMask or compatible EVM wallet
- The target network added to MetaMask:
  - **Testnet3 (development):** GOAT Testnet3, chain ID `48816`, RPC `https://rpc.testnet3.goat.network`, explorer `https://explorer.testnet3.goat.network`
  - **Mainnet (production):** GOAT mainnet, chain ID `2345`, RPC `https://rpc.goat.network`, explorer `https://explorer.goat.network`
- Sufficient token balance (e.g., USDT)
- Small amount of native tokens for gas

**Getting tokens:**
- **Testnet3 (development):** Native BTC for gas from the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet)
- **Testnet3 (development):** Test USDT/USDC: ask the GoatX402 team, or use a faucet contract if available
- **Mainnet (production):** Use production GOAT mainnet gas and the production token contracts configured in Admin Dashboard / `GET /admin/tokens?chain_id=2345`

---

## 8. Developer: API-Only Test Payment

For headless testing without a browser/wallet, you can use `curl` + Foundry's `cast`. The concrete payload below is **Testnet3 (development)**. For **Mainnet (production)**, set `chainId` to `2345`, use a production token contract from `GET /admin/tokens?chain_id=2345`, and use `https://rpc.goat.network`.

### 8a. Create an Order

```bash
# Testnet3 (development): GOAT Testnet3 chain_id=48816, seeded USDT.
curl -X POST http://localhost:3001/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 48816,
    "tokenSymbol": "USDT",
    "tokenContract": "0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3",
    "fromAddress": "0xYOUR_WALLET",
    "amountWei": "1000000"
  }'
```

Response from the demo backend (HTTP 200 JSON). The backend wraps the server SDK; Core's raw `POST /api/v1/orders` response is HTTP 402 = **success** in x402 protocol:
```json
{
  "orderId": "007a6713-...",
  "flow": "ERC20_APPROVE_XFER",
  "payToAddress": "0x8D5403Cd...",
  "expiresAt": 1771831788
}
```

### 8b. Send Payment On-Chain

```bash
# Testnet3 (development): uses GOAT Testnet3 RPC and testnet-only gas-tip values.
cast send <TOKEN_CONTRACT> \
  "transfer(address,uint256)" <PAY_TO_ADDRESS> <AMOUNT_WEI> \
  --private-key <YOUR_KEY> \
  --rpc-url https://rpc.testnet3.goat.network \
  --gas-limit 100000 \
  --priority-gas-price 130000 \
  --gas-price 1000000

# Mainnet (production): use GOAT mainnet RPC and production gas policy.
cast send <TOKEN_CONTRACT> \
  "transfer(address,uint256)" <PAY_TO_ADDRESS> <AMOUNT_WEI> \
  --private-key <YOUR_KEY> \
  --rpc-url https://rpc.goat.network
```

### 8c. Poll Order Status

```bash
curl http://localhost:3001/api/orders/<ORDER_ID>
```

Status transitions:
```
CHECKOUT_VERIFIED → PAYMENT_CONFIRMED → INVOICED
                  → EXPIRED (timeout)
                  → CANCELLED (manual)
```

---

## 9. Full Test Log (Real Example)

Two complete end-to-end tests performed on **Testnet3 (development)** GOAT Testnet3. These are historical development examples; for **Mainnet (production)** use GOAT mainnet chain ID `2345`, RPC `https://rpc.goat.network`, explorer `https://explorer.goat.network`, and production token contracts from the Admin Dashboard/API.

### Test 1: Openclaw_001 (2026-02-23)

**Setup:** Merchant pre-configured by admin via Dashboard.

| Item | Value |
|---|---|
| Merchant | `Openclaw_001` |
| Chain | **Testnet3 (development)** GOAT Testnet3 (`48816`) |
| Token | **Testnet3 (development)** USDT (`0xdce0af57...`) |
| Test Wallet | `0x2612567DFf7B6e03340d153F83a7Ca899c0b6299` |
| Callback Contract | `0x3D62128a3b1601cbc015E8a98Eda9BA051319ed4` |

**Flow:**

```bash
# 1. Health check
$ curl http://localhost:3001/api/health
{"status":"ok"}

# 2. Verify config — 3 chains, USDC+USDT each
$ curl http://localhost:3001/api/config
{"merchantId":"Openclaw_001","chains":[...3 chains...]}

# 3. Testnet3 (development): create order (1 USDT)
$ curl -X POST http://localhost:3001/api/orders -H "Content-Type: application/json" \
  -d '{"chainId":48816,"tokenSymbol":"USDT","tokenContract":"0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3","fromAddress":"0x2612567DFf7B6e03340d153F83a7Ca899c0b6299","amountWei":"1000000"}'
{"orderId":"007a6713-d1f0-45b2-be6c-e1e45ee81564","flow":"ERC20_APPROVE_XFER","payToAddress":"0x8D5403Cd1deD2982c758594BEcb4571A5B864057"}

# 4. Testnet3 (development): send 1 USDT to TSS wallet
$ cast send 0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3 \
  "transfer(address,uint256)" 0x8D5403Cd1deD2982c758594BEcb4571A5B864057 1000000 \
  --private-key $PK --rpc-url https://rpc.testnet3.goat.network \
  --gas-limit 100000 --priority-gas-price 130000 --gas-price 1000000
# status: 1 (success)
# transactionHash: 0x96395b112eece299cc5d91e5d0f58a53180a5aac709e20fbd18de4f9905b911a

# 5. Poll status
$ curl http://localhost:3001/api/orders/007a6713-d1f0-45b2-be6c-e1e45ee81564
# Poll 1: {"status":"CHECKOUT_VERIFIED"}
# Poll 2: {"status":"PAYMENT_CONFIRMED","txHash":"0x96395b11...","confirmedAt":"2026-02-23T07:10:05Z"}
```

✅ **Result:** Payment confirmed in ~5 seconds.
🔗 **Testnet3 (development) explorer:** [View transaction](https://explorer.testnet3.goat.network/tx/0x96395b112eece299cc5d91e5d0f58a53180a5aac709e20fbd18de4f9905b911a)

### Test 2: claw_demo (2026-02-24)

**Setup:** Merchant created entirely via Admin CLI (no Dashboard needed).

```bash
# Admin: Create merchant
$ curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants" -d '{
  "merchant_id":"claw_demo","name":"Claw Demo Shop","receive_type":"DELEGATE","generate_api_keys":true}'
{"api_key":"gHfeB7Il...","api_secret":"rIeDeF0M...","success":true}

# Admin: Testnet3 (development) add USDT address
$ curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/claw_demo/addresses" -d '{
  "chain_id":48816,"token_contract":"0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3","symbol":"USDT","address":"0x2612567DFf7B6e03340d153F83a7Ca899c0b6299"}'
{"success":true}

# Admin: Testnet3 (development) add USDC address
$ curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/claw_demo/addresses" -d '{
  "chain_id":48816,"token_contract":"0x29d1ee93e9ecf6e50f309f498e40a6b42d352fa1","symbol":"USDC","address":"0x2612567DFf7B6e03340d153F83a7Ca899c0b6299"}'
{"success":true}

# Admin: Testnet3 (development) register callback contract
$ curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/claw_demo/callback-contracts" -d '{
  "chain_id":48816,"spent_address":"0x3D62128a3b1601cbc015E8a98Eda9BA051319ed4","eip712_name":"GoatX402 Pay Callback","eip712_version":"1"}'
{"success":true}

# Admin: Top up fee balance
$ curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/fees/topup" -d '{"merchant_id":"claw_demo","amount_usd":100,"description":"Initial topup"}'
{"new_balance":100,"success":true}

# Admin: Verify
$ curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants/claw_demo" | jq .
# → enabled: true, 2 addresses, 1 callback contract, fee balance: $100

# Developer: Testnet3 (development) create order to verify
$ curl -s -X POST http://localhost:3001/api/orders -H "Content-Type: application/json" \
  -d '{"chainId":48816,"tokenSymbol":"USDT","tokenContract":"0xdce0af57e8f2ce957b3838cd2a2f3f3677965dd3","fromAddress":"0x2612567DFf7B6e03340d153F83a7Ca899c0b6299","amountWei":"1000000"}'
{"orderId":"63c0d5e8-c33d-4d64-b4d4-c85051245f94","flow":"ERC20_APPROVE_XFER","payToAddress":"0x8D5403Cd1deD2982c758594BEcb4571A5B864057"}
```

✅ **Result:** Full **Testnet3 (development)** merchant setup + order creation via CLI only — no Dashboard needed.

---

## 10. Go-Live Checklist

### Admin
- [ ] Merchant created with API credentials (`generate_api_keys: true`)
- [ ] Token addresses added for all target chains
- [ ] Fee balance topped up (`admin/fees/topup`)
- [ ] Callback contract registered (if using DELEGATE flow)
- [ ] Fee balance monitoring/alerts in place

### Developer
- [ ] `API_SECRET` stored server-side only, never in frontend
- [ ] `.env` is in `.gitignore`
- [ ] Order status polling implemented
- [ ] Proof retrieval implemented (for on-chain verification)
- [ ] Auto-cancel stale `CHECKOUT_VERIFIED` orders
- [ ] Error handling for all [common errors](API.md)
- [ ] If DELEGATE flow: calldata signature submission works

### User-Facing
- [ ] Target network details documented for users (chain ID, RPC URL, explorer URL)
- [ ] **Testnet3 (development):** faucet and test token instructions documented
- [ ] **Mainnet (production):** production token contracts verified in Admin Dashboard/API
- [ ] Clear error messages when wallet is on wrong network
- [ ] Payment timeout handling with user feedback

---

## 11. Troubleshooting

### Admin Issues

| Error | Cause | Fix (CLI) |
|---|---|---|
| `merchant not found` | Merchant not created | `POST /admin/merchants` |
| `insufficient fee balance` | Fee balance is 0 | `POST /admin/fees/topup` |
| `token not supported on chain` | No address for this chain/token | `POST /admin/merchants/{id}/addresses` |
| `callback contract not configured` | Missing callback contract | `POST /admin/merchants/{id}/callback-contracts` |
| Need to check merchant status | — | `GET /admin/merchants/{id}` |
| Need to check fee balance | — | `GET /admin/fees/balance/{id}` |

### Developer Issues

| Error | Cause | Fix |
|---|---|---|
| `Invalid API Key` (401) | Wrong credentials | Verify `API_KEY`/`API_SECRET`; rotate if needed |
| `HMAC signature invalid` (401) | Timestamp drift or SDK mismatch | Sync server clock (NTP); update SDK |
| Empty `chains` in config | No addresses configured | Admin: add addresses per chain/token |
| Server exits silently | Unhandled exception | Add `process.on('uncaughtException')` handler |
| Order stays `CHECKOUT_VERIFIED` | Payment not detected | Verify exact `amountWei` to the correct payment target (`payTo` / legacy `payToAddress`) |
| `gas required exceeds allowance` | Insufficient native balance | **Testnet3 (development):** get gas from the [GOAT Testnet3 faucet](https://bridge.testnet3.goat.network/faucet). **Mainnet (production):** fund with production native gas. |
| `gas tip cap below minimum` | Gas price too low | **Testnet3 (development):** set `--priority-gas-price 130000`. **Mainnet (production):** use production gas policy. |

### User Issues

| Issue | Fix |
|---|---|
| MetaMask wrong network | **Testnet3 (development):** add GOAT Testnet3 chain `48816`, RPC `https://rpc.testnet3.goat.network`. **Mainnet (production):** add GOAT mainnet chain `2345`, RPC `https://rpc.goat.network`. |
| "Insufficient funds" | **Testnet3 (development):** get test gas/tokens from faucet/team. **Mainnet (production):** fund production gas/token balances. |
| Transaction pending forever | Increase gas price; check network status |

---

## Admin CLI Quick Reference

```bash
# Setup: run the session login + mandatory TOTP flow in "Prerequisites (CLI Session Auth)" first.
# Mainnet (production)
export API_URL="https://api.x402.goat.network"
# Testnet3 (development): export API_URL="<testnet3-api-base>" instead.

# Merchant CRUD
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants"                              # List
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/merchants/my_shop"                      # Get
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants" -d '{...}'                                     # Create
curl -s -X PUT -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop" -d '{...}'                             # Update

# Merchant addresses
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/addresses" -d '{...}'                   # Add
# Testnet3 (development): chain_id=48816. Mainnet (production): use 2345.
curl -s -X DELETE -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  "$API_URL/admin/merchants/my_shop/addresses/48816/USDT"                   # Remove

# Callback contracts
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/merchants/my_shop/callback-contracts" -d '{...}'          # Add
# Testnet3 (development): chain_id=48816. Mainnet (production): use 2345.
curl -s -X DELETE -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  "$API_URL/admin/merchants/my_shop/callback-contracts/48816"               # Remove

# Fees
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/fees/balance/my_shop"                   # Check
curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  "$API_URL/admin/fees/topup" -d '{"merchant_id":"my_shop","amount_usd":100}' # Topup

# System
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/health"                                 # Health
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/stats"                                  # Stats
curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API_URL/admin/orders?merchant_id=my_shop"             # Orders
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    ADMIN (Dashboard / CLI)                       │
│                                                                  │
│  1. Create merchant         4. Register callback contract        │
│  2. Add token addresses     5. Top up fee balance                │
│  3. Generate API keys       6. Monitor orders & fees             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ configures
                               ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│   Frontend   │────▶│   Backend    │────▶│   GoatX402 Core API  │
│  (User)      │     │  (Developer) │     │                      │
│              │     │              │     │  • Order management   │
│ • Connect    │     │ • HMAC auth  │     │  • Payment watching   │
│   wallet     │     │ • Create     │     │  • Fee deduction      │
│ • Sign EIP-  │     │   orders     │     │  • Proof issuance     │
│   712 data   │     │ • Poll       │     │  • Settlement         │
│ • Transfer   │     │   status     │     │                      │
│   tokens     │     │ • Get proof  │     │                      │
└──────────────┘     └──────────────┘     └──────────┬───────────┘
                                                     │ watches
                                                     ▼
                                          ┌──────────────────────┐
                                          │     Blockchain       │
                                          │                      │
                                          │ • Token transfers    │
                                          │ • Callback contracts │
                                          │ • TSS settlement     │
                                          └──────────────────────┘
```

---

## Further Reading

- [API Reference](API.md) — Full API docs with request/response schemas
- [Developer Guide](DEVELOPER_FAST.md) — Technical integration deep dive
- [goatx402-sdk](goatx402-sdk/) — Frontend SDK (EVM wallets)
- [goatx402-sdk-server-ts](goatx402-sdk-server-ts/) — TypeScript server SDK repo directory; npm package name: `goatx402-sdk-server`
- [goatx402-sdk-server-go](goatx402-sdk-server-go/) — Server SDK (Go)
- [goatx402-contract](goatx402-contract/) — Callback contract (Foundry)
