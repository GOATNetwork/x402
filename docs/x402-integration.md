# GOAT Flow Integration Guide

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start (10 minutes)](#2-quick-start-10-minutes)
3. [Architecture & System Structure](#3-architecture--system-structure)
4. [Two Payment Modes Explained](#4-two-payment-modes-explained)
5. [Fee Model](#5-fee-model)
6. [Backend Integration (Server SDK)](#6-backend-integration-server-sdk)
7. [Frontend Integration (Client SDK)](#7-frontend-integration-client-sdk)
8. [Security & Authentication Model](#8-security--authentication-model)
9. [API Reference](#9-api-reference)
10. [Error Handling & Troubleshooting](#10-error-handling--troubleshooting)
11. [Versioning & Compatibility](#11-versioning--compatibility)
12. [Best Practices](#12-best-practices)
13. [Appendix](#13-appendix)
14. [Gaps & TODOs](#14-gaps--todos)

---

## 1. Overview

### 1.1 What is GOAT Flow

GOAT Flow is an EVM payment infrastructure for merchants, applications, and agent-oriented workflows. It provides two payment receiving modes to meet different merchant needs.

### 1.2 SDK Components

| SDK | Purpose | Package |
|-----|---------|---------|
| **goatflow-sdk** | Frontend client SDK | `npm install goatflow-sdk` |
| **goatflow-sdk-server** | TypeScript backend SDK | `npm install goatflow-sdk-server` |
| **goatflow-sdk-server** (Go) | Go backend SDK (source-only) | [Clone this repo and use a local `replace`](../goatx402-sdk-server-go/README.md) |
| **goatflow-checkout** | Drop-in hosted browser checkout | `npm install goatflow-checkout` |
| **goatflow-quickpay** | QuickPay public payer / agent library and CLI | `npm install goatflow-quickpay` |

### 1.3 Two Payment Modes

| Mode | Identifier | Receiving Method | Fixed Fee | Use Case |
|------|------------|------------------|-----------|----------|
| **Direct Mode** | `DIRECT` | User transfers directly to merchant wallet | Lower (e.g., $0.10/tx) | Simple payments, no callbacks |
| **Delegate Mode** | `DELEGATE` | User transfers to TSS wallet; system settles on the merchant chain | Higher (e.g., $0.20/tx) | Callbacks, complex business logic |

### 1.4 Supported Blockchain Networks

| Network | Chain ID | DIRECT | DELEGATE | Explorer |
|---------|---------:|:------:|:--------:|----------|
| Ethereum | 1 | Yes | Yes | etherscan.io |
| Polygon | 137 | Yes | Yes | polygonscan.com |
| BSC | 56 | Yes | Yes | bscscan.com |
| Arbitrum | 42161 | Yes | Yes | arbiscan.io |
| Optimism | 10 | Yes | Yes | optimistic.etherscan.io |
| Avalanche | 43114 | Yes | Yes | snowtrace.io |
| Base | 8453 | Yes | Yes | basescan.org |
| Berachain | 80094 | Yes | Yes | berascan.com |
| X Layer | 196 | Yes | Yes | web3.okx.com/explorer/x-layer/evm |
| GOAT | 2345 | Yes | Yes | explorer.goat.network |
| Metis | 1088 | Yes | No | andromeda-explorer.metis.io |
| Tempo | 4217 | Yes | No | explore.tempo.xyz |

---

## 2. Quick Start (10 minutes)

### 2.1 Prerequisites

1. **Merchant Account**: Contact GOAT Flow to obtain
2. **API Credentials**: `API_KEY` and `API_SECRET`
3. **Fee Balance**: Ensure sufficient USD fee balance

### 2.2 Installation

```bash
# Backend SDK
npm install goatflow-sdk-server

# Frontend SDK
npm install goatflow-sdk ethers

# QuickPay public payer / agent CLI
npm install goatflow-quickpay

# Drop-in hosted browser checkout
npm install goatflow-checkout
```

### 2.3 Backend: Create Order

```typescript
import { GoatFlowClient } from 'goatflow-sdk-server'
import type { Order as ServerOrder } from 'goatflow-sdk-server'
import type { Order as ClientOrder } from 'goatflow-sdk'

// Initialize client
const client = new GoatFlowClient({
  baseUrl: 'https://flow-api.goat.network',
  apiKey: process.env.GOATX402_API_KEY,
  apiSecret: process.env.GOATX402_API_SECRET,
})

function toClientOrder(order: ServerOrder, fromAddress: string): ClientOrder {
  // Server SDK uses fromChainId/payToChainId; browser SDK expects chainId.
  return { ...order, fromAddress, chainId: order.fromChainId }
}

// Create payment order and return the browser-SDK shape to your frontend
async function createOrder(userAddress: string, amount: string) {
  const order = await client.createOrder({
    dappOrderId: `order_${Date.now()}`,  // Merchant order ID
    chainId: 137,                         // Polygon
    tokenSymbol: 'USDC',
    tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    fromAddress: userAddress,             // User wallet address
    amountWei: '10000000',                // 10 USDC (6 decimals)
    // callbackCalldata: '0x...',         // Optional: callback data (delegate mode only)
  })

  return toClientOrder(order, userAddress)
}
```

### 2.4 Frontend: Execute Payment

```typescript
import { PaymentHelper, type Order as ClientOrder } from 'goatflow-sdk'
import { ethers } from 'ethers'

async function executePayment(order: ClientOrder) {
  // Connect wallet
  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()
  const payment = new PaymentHelper(signer)

  // If callback sign request exists (delegate mode), sign first
  if (order.calldataSignRequest) {
    const signature = await payment.signCalldata(order)
    await submitSignatureToBackend(order.orderId, signature)
  }

  // Execute payment
  const result = await payment.pay(order)

  if (result.success) {
    console.log('Payment successful:', result.txHash)
  }
}
```

### 2.5 Verify Integration

```typescript
// Query order status
const status = await client.getOrderStatus(orderId)

// Order status flow
// CHECKOUT_VERIFIED → PAYMENT_CONFIRMED → INVOICED
```

---

## 3. Architecture & System Structure

### 3.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Merchant System                             │
│  ┌──────────────────┐        ┌──────────────────┐              │
│  │  Merchant Backend │        │ Merchant Frontend │              │
│  │  (Server SDK)     │        │  (Client SDK)     │              │
│  └────────┬─────────┘        └────────┬─────────┘              │
└───────────┼────────────────────────────┼────────────────────────┘
            │                            │
            │ HMAC Signature Auth        │ Wallet Interaction
            ▼                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                      GOAT Flow Platform                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  API Gateway │  │ Payment Eng │  │ TSS Gateway │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ EVM Watcher │  │ Orchestrator│  │ Fee System  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└───────────────────────────────────────────────────────────────────┘
            │                            │
            ▼                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Blockchain Networks                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Ethereum │  │ Polygon  │  │   BSC    │  │  GOAT    │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow Overview

```mermaid
sequenceDiagram
    participant User as User
    participant MFE as Merchant Frontend
    participant MBE as Merchant Backend
    participant API as GOAT Flow API
    participant Chain as Blockchain

    MBE->>API: 1. Create Order (Server SDK)
    API-->>MBE: 2. Return Order (with payToAddress)
    MBE-->>MFE: 3. Pass order info
    MFE->>User: 4. Display payment UI
    User->>MFE: 5. Confirm payment
    MFE->>Chain: 6. Send token transfer (Client SDK)
    Chain-->>API: 7. Transfer event detected
    API->>API: 8. Process payment confirmation
    API-->>MBE: 9. Webhook notification (optional)
```

---

## 4. Two Payment Modes Explained

### 4.1 Direct Mode (DIRECT)

**Overview**: User directly transfers tokens to merchant's wallet address, without GOAT Flow intermediation.

**Features**:
- Simplest payment method
- Lowest fixed fee
- No TSS wallet involvement
- No callback support

**Payment Flow**:

```mermaid
sequenceDiagram
    participant User as User Wallet
    participant SDK as Client SDK
    participant Token as Token Contract
    participant Merchant as Merchant Wallet
    participant API as GOAT Flow API

    SDK->>Token: 1. Check balance
    Token-->>SDK: Balance sufficient
    SDK->>User: 2. Request signature
    User->>Token: 3. transfer(merchant, amount)
    Token-->>Merchant: 4. Tokens arrive directly
    Token-->>SDK: 5. Transaction receipt
    API->>API: 6. Watcher detects transfer
    API->>API: 7. Update order status
```

**Flow Types**: `ERC20_DIRECT`

**Code Example**:

```typescript
// Backend creates order
const order = await client.createOrder({
  dappOrderId: 'order_001',
  chainId: 137,
  tokenSymbol: 'USDC',
  tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  fromAddress: userWallet,
  amountWei: '10000000',
  // No callbackCalldata - Direct mode
})

// order.flow = 'ERC20_DIRECT'
// order.payToAddress = Merchant wallet address
```

---

### 4.2 Delegate Mode (DELEGATE)

**Overview**: The user transfers tokens to a TSS wallet on the selected source
chain. GOAT Flow then pays out and optionally executes the callback on the
merchant's configured callback/settlement chain, which may be the same chain.

**Features**:
- Supports callback functionality (execute merchant contracts)
- Higher fixed fee (includes TSS payout gas cost)
- TSS multi-sig wallet ensures fund security
- Supports complex business logic
- Requires Permit2 / EIP-3009 support and an approved callback contract on the merchant chain
- Supports eligible cross-chain source payments while the merchant callback chain remains fixed

**Payment Flow**:

```mermaid
sequenceDiagram
    participant User as User Wallet
    participant SDK as Client SDK
    participant Token as Token Contract
    participant TSS as TSS Wallet
    participant API as GOAT Flow API
    participant Merchant as Merchant Wallet

    SDK->>Token: 1. Check balance
    Token-->>SDK: Balance sufficient

    Note over SDK,User: If callback sign request exists
    SDK->>User: 2. Request EIP-712 signature
    User-->>SDK: 3. Return signature
    SDK->>API: 4. Submit signature

    SDK->>User: 5. Request transfer signature
    User->>Token: 6. transfer(TSS, amount)
    Token-->>TSS: 7. Tokens arrive at TSS
    Token-->>SDK: 8. Transaction receipt

    API->>API: 9. Watcher detects transfer
    API->>API: 10. Create Payout task
    API->>TSS: 11. Request TSS signature
    TSS-->>API: 12. Return signature
    API->>Token: 13. Execute Payout (with callback)
    Token-->>Merchant: 14. Tokens arrive
```

**Flow Types**: `ERC20_3009`, `ERC20_APPROVE_XFER`

**Code Example**:

```typescript
// Backend creates order (with callback)
const order = await client.createOrder({
  dappOrderId: 'order_002',
  chainId: 137,
  tokenSymbol: 'USDC',
  tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  fromAddress: userWallet,
  amountWei: '10000000',
  callbackCalldata: '0x...', // Callback data (optional)
})

// order.flow = 'ERC20_3009' or 'ERC20_APPROVE_XFER'
// order.payToAddress = TSS wallet address
// order.calldataSignRequest = EIP-712 sign request (if callback exists)
```

---

### 4.3 Mode Comparison

| Feature | Direct Mode (DIRECT) | Delegate Mode (DELEGATE) |
|---------|----------------------|--------------------------|
| **Receiving Address** | Merchant wallet | TSS wallet |
| **Fixed Fee** | Lower (e.g., $0.10) | Higher (e.g., $0.20) |
| **Funds Arrival** | Immediate after user transfer | After TSS Payout |
| **Callback Support** | ❌ Not supported | ✅ Supported |
| **Use Case** | Simple payments | Complex business logic |
| **Gas Cost** | User only | User + TSS both need Gas |
| **Chain relation** | Payment and receiving chain are the same | Source chain may differ from the single merchant callback chain |

---

## 5. Fee Model

### 5.1 Fee Structure

GOAT Flow uses a **fixed fee** model (not percentage), charged per order.

| Fee Type | Direct Mode | Delegate Mode | Description |
|----------|-------------|---------------|-------------|
| Order Fee | `fee_usd_direct` | `fee_usd_delegate` | Fixed USD fee configured per chain |
| Default Fee | $0.10/tx | $0.20/tx | Customizable per chain |

**Why is Delegate Mode fee higher?**
- TSS needs to execute Payout transaction
- Additional on-chain gas cost
- Multi-signature security mechanism cost

### 5.2 Fee Balance System

Merchants need to **pre-fund a USD fee balance**, deducted when orders are created.

```
┌─────────────────────────────────────────────────────┐
│                Fee Balance Flow                      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. Operator topup → merchant_fee_balance += $100   │
│                                                     │
│  2. Create order → Check balance                    │
│     ├─ Insufficient → Return HTTP 400 error         │
│     └─ Sufficient → Charge fee, create order        │
│                                                     │
│  3. Payment successful → Fee consumed (no refund)   │
│                                                     │
│  4. Order expired → Fee refunded → balance += fee   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 5.3 Fee Calculation Examples

```typescript
// Direct mode order
const directOrder = {
  chainId: 137,  // Polygon
  mode: 'DIRECT',
  fee: '$0.10',  // Fixed fee
}

// Delegate mode order
const delegateOrder = {
  chainId: 137,  // Polygon
  mode: 'DELEGATE',
  fee: '$0.20',  // Fixed fee (includes Payout Gas)
}

// Whether order amount is $10 or $10,000, fee is fixed
```

### 5.4 Insufficient Balance Handling

```typescript
try {
  const order = await client.createOrder(orderParams)
} catch (error) {
  if (error.status === 400 && error.message?.includes('insufficient fee balance')) {
    // Fee balance insufficient
    console.error('Insufficient fee balance, please contact operator to topup')
    // error.message: "Insufficient fee balance"
  }
}
```

---

## 6. Backend Integration (Server SDK)

### 6.1 Initialization

```typescript
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL,    // API URL
  apiKey: process.env.GOATX402_API_KEY,      // API Key
  apiSecret: process.env.GOATX402_API_SECRET, // API Secret
})
```

### 6.2 Create Order

```typescript
interface CreateOrderParams {
  dappOrderId: string       // Merchant order ID (unique)
  chainId: number           // Chain ID
  tokenSymbol: string       // Token symbol
  tokenContract: string     // Token contract address
  fromAddress: string       // Payer address
  amountWei: string         // Amount (smallest unit)
  callbackCalldata?: string // Callback data (delegate mode optional)
}

const order = await client.createOrder({
  dappOrderId: `order_${Date.now()}`,
  chainId: 137,
  tokenSymbol: 'USDC',
  tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  fromAddress: '0x742d35Cc6634C0532925a3b844Bc...',
  amountWei: '10000000', // 10 USDC
})
```

### 6.3 Order Response

```typescript
interface OrderResponse {
  orderId: string                  // GOAT Flow order ID
  flow: PaymentFlow                // Payment flow type
  payToAddress: string             // Receiving address
  expiresAt: number                // Expiration time (Unix timestamp)
  calldataSignRequest?: {          // EIP-712 sign request (if callback exists)
    domain: EIP712Domain
    types: Record<string, EIP712Type[]>
    primaryType: string
    message: SignMessage
  }
}
```

The raw create-order response is an x402 challenge. `HTTP 402` is the expected success path for order creation, and the `PAYMENT-REQUIRED` header contains the base64-encoded JSON challenge body.

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Miwi...
Content-Type: application/json
```

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://flow-api.goat.network/api/v1/orders/{order_id}",
    "description": "Payment: 10000000 USDC",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:137",
      "amount": "10000000",
      "asset": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "payTo": "0xMerchantOrTssAddress",
      "maxTimeoutSeconds": 585,
      "extra": {
        "flow": "ERC20_DIRECT",
        "tokenSymbol": "USDC"
      }
    }
  ],
  "extensions": {
    "goatx402": {
      "destinationChain": "eip155:137",
      "expiresAt": 1760000600,
      "paymentMethod": "transfer",
      "receiveType": "DIRECT"
    }
  },
  "order_id": "{order_id}",
  "flow": "ERC20_DIRECT",
  "token_symbol": "USDC"
}
```

`maxTimeoutSeconds` is the order's remaining lifetime when the challenge is generated (clamped to at least 1 second), not a fixed 600-second window.

For `ERC20_3009`, `accepts[0].scheme` is `exact-eip3009`. Whenever the order carries a `calldata_sign_request`—including Permit2-style DELEGATE callbacks—`extensions.goatx402.signatureEndpoint` points to `POST /api/v1/orders/{order_id}/calldata-signature`.

### 6.4 Query Order Status

```typescript
const status = await client.getOrderStatus(orderId)

// status.status possible values:
// - 'CHECKOUT_VERIFIED'  : Awaiting payment
// - 'PAYMENT_CONFIRMED'  : Payment confirmed
// - 'INVOICED'           : Complete (invoiced)
// - 'EXPIRED'            : Expired
// - 'FAILED'             : Failed
// - 'CANCELLED'          : Cancelled before payment
```

### 6.5 Submit Callback Signature

```typescript
// After user signs on frontend, submit to backend
await client.submitCalldataSignature(orderId, '0x...')
```

### 6.6 Get Order Proof

```typescript
// Get proof after payment completion
const proof = await client.getOrderProof(orderId)

// proof contains the on-chain tx hash plus an unsigned content checksum.
// Verify proof.payload.tx_hash on-chain when independent proof is required.
```

---

## 7. Frontend Integration (Client SDK)

### 7.1 Installation & Initialization

```typescript
import {
  PaymentHelper,
  ERC20Token,
  parseUnits,
  formatUnits,
  type Order as ClientOrder,
} from 'goatflow-sdk'
import { ethers } from 'ethers'

// Connect wallet
const provider = new ethers.BrowserProvider(window.ethereum)
await provider.send('eth_requestAccounts', [])
const signer = await provider.getSigner()

// Create PaymentHelper
const payment = new PaymentHelper(signer)
```

The server SDK returns `fromChainId` and `payToChainId`. Before passing an order to the browser SDK, map `chainId` from `fromChainId` and include the payer address used at order creation.

```typescript
import type { Order as ServerOrder } from 'goatflow-sdk-server'

function toClientOrder(serverOrder: ServerOrder, fromAddress: string): ClientOrder {
  return { ...serverOrder, fromAddress, chainId: serverOrder.fromChainId }
}
```

### 7.2 Complete Payment Flow

```typescript
async function processPayment(order: ClientOrder) {
  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()
  const payment = new PaymentHelper(signer)

  // 1. Verify network
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== order.chainId) {
    await provider.send('wallet_switchEthereumChain', [
      { chainId: `0x${order.chainId.toString(16)}` },
    ])
  }

  // 2. Check balance
  const balance = await payment.getTokenBalance(order.tokenContract)
  const required = BigInt(order.amountWei)
  if (balance < required) {
    throw new Error('Insufficient balance')
  }

  // 3. If callback sign request exists (delegate mode), sign first
  if (order.calldataSignRequest) {
    const signature = await payment.signCalldata(order)
    // Submit signature to backend
    await fetch('/api/orders/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: order.orderId, signature }),
    })
  }

  // 4. Execute payment
  const result = await payment.pay(order)

  if (result.success) {
    console.log('Transaction hash:', result.txHash)
    // Notify backend payment initiated
    await fetch('/api/orders/notify', {
      method: 'POST',
      body: JSON.stringify({ orderId: order.orderId, txHash: result.txHash }),
    })
  }

  return result
}
```

### 7.3 React Hook Example

```typescript
// hooks/useGoatFlowPayment.ts
import { useState, useCallback } from 'react'
import { PaymentHelper, type Order as ClientOrder, type PaymentResult } from 'goatflow-sdk'
import { ethers } from 'ethers'

export function useGoatFlowPayment() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pay = useCallback(async (order: ClientOrder): Promise<PaymentResult | null> => {
    setLoading(true)
    setError(null)

    try {
      const provider = new ethers.BrowserProvider(window.ethereum)
      const signer = await provider.getSigner()
      const payment = new PaymentHelper(signer)

      // Handle callback signature
      if (order.calldataSignRequest) {
        const sig = await payment.signCalldata(order)
        await submitSignature(order.orderId, sig)
      }

      const result = await payment.pay(order)

      if (!result.success) {
        setError(result.error || 'Payment failed')
      }

      return result
    } catch (err: any) {
      const msg = err.code === 'ACTION_REJECTED'
        ? 'User cancelled operation'
        : err.message
      setError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  return { pay, loading, error }
}
```

### 7.4 Pay Button Component

```tsx
// components/PayButton.tsx
import { useGoatFlowPayment } from '../hooks/useGoatFlowPayment'
import type { Order as ClientOrder } from 'goatflow-sdk'

interface PayButtonProps {
  order: ClientOrder
  onSuccess: (txHash: string) => void
  onError: (error: string) => void
}

export function PayButton({ order, onSuccess, onError }: PayButtonProps) {
  const { pay, loading, error } = useGoatFlowPayment()

  const handleClick = async () => {
    const result = await pay(order)
    if (result?.success && result.txHash) {
      onSuccess(result.txHash)
    } else if (result?.error) {
      onError(result.error)
    }
  }

  return (
    <button onClick={handleClick} disabled={loading}>
      {loading ? 'Processing...' : `Pay ${formatAmount(order)}`}
    </button>
  )
}
```

---

## 8. Security & Authentication Model

### 8.1 Backend API Authentication (HMAC-SHA256)

```typescript
// Server SDK handles signature automatically
// Signature algorithm:
// 1. Add api_key, timestamp, and nonce to request body/query params
// 2. Drop empty values and `sign`
// 3. Sort params by ASCII key
// 4. Concatenate: key1=value1&key2=value2
// 5. HMAC-SHA256(secret, payload)

// Request headers:
// X-API-Key: {apiKey}
// X-Timestamp: {unixSeconds}
// X-Nonce: {uniqueRequestNonce}
// X-Sign: {hmacSignature}
```

### 8.2 EIP-712 Signature (Callback Authorization)

```typescript
// User signature authorizes callback execution.
// Sign the calldataSignRequest returned by createOrder; do not rebuild it.
if (!order.calldataSignRequest) {
  throw new Error('Order does not require calldata signature')
}

const { EIP712Domain, ...types } = order.calldataSignRequest.types
const signature = await signer.signTypedData(
  order.calldataSignRequest.domain,
  types,
  order.calldataSignRequest.message
)

// order.calldataSignRequest.domain is returned by GOAT Flow and must match
// the deployed MerchantCallback EIP-712 domain. MerchantCallback.initialize()
// defaults to name "GoatX402 Pay Callback" and version "1".
```

Returned callback message shapes:

```typescript
type Eip3009CallbackData = {
  token: string
  owner: string
  payer: string
  amount: string
  orderId: string       // bytes32 keccak256(orderId)
  calldataNonce: string // replay protection nonce
  deadline: string
  calldataHash: string  // keccak256(callback calldata)
}

type Permit2CallbackData = Eip3009CallbackData & {
  permit2: string
}
```

### 8.3 Security Mechanisms

| Mechanism | Description |
|-----------|-------------|
| **Nonce** | Each signature unique, prevents replay attacks |
| **Deadline** | Signature validity period, invalid after expiry |
| **Chain ID** | Bound to chain ID, prevents cross-chain replay |
| **Contract Binding** | Bound to contract address, prevents cross-contract replay |
| **Calldata Hash** | Callback data hash, prevents tampering |

---

## 9. API Reference

### 9.1 PaymentHelper Class

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `constructor(signer)` | `ethers.Signer` | - | Initialize |
| `getAddress()` | - | `Promise<string>` | Get wallet address |
| `pay(order)` | `Order` | `Promise<PaymentResult>` | Execute payment |
| `signCalldata(order)` | `Order` | `Promise<string>` | Sign callback data |
| `getTokenBalance(token)` | `string` | `Promise<bigint>` | Query token balance |
| `getTokenAllowance(token, spender)` | `string, string` | `Promise<bigint>` | Query allowance |
| `approveToken(token, spender, amount, options?)` | `string, string, bigint, ApprovalOptions?` | `Promise<TransactionResponse \| undefined>` | Exact approval by default; `unlimited: true` opts into unlimited approval; resolves after confirmation, or with `undefined` when the allowance already equals the requested value (including revoking an already-zero allowance); changing a non-zero allowance first simulates the direct write via eth_call — standard ERC20s get a single approval with no reset window, only USDT-style tokens fall back to a confirmed approve(0) reset first |

### 9.2 ERC20Token Class

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `constructor(address, signerOrProvider)` | `string, Signer|Provider` | - | Initialize |
| `balanceOf(address)` | `string` | `Promise<bigint>` | Query balance |
| `allowance(owner, spender)` | `string, string` | `Promise<bigint>` | Query allowance |
| `decimals()` | - | `Promise<number>` | Get decimals |
| `symbol()` | - | `Promise<string>` | Get symbol |
| `approve(spender, amount)` | `string, bigint` | `Promise<TransactionResponse>` | Approve |
| `transfer(to, amount)` | `string, bigint` | `Promise<TransactionResponse>` | Transfer |
| `ensureApproval(owner, spender, amount, options?)` | `string, string, bigint, ApprovalOptions?` | `Promise<{needed, tx?, resetTx?}>` | Judge sufficiency against the requested amount; otherwise simulate the direct write first and only use a confirmed approve(0) reset for USDT-style tokens; `unlimited` only changes the value written |
| `setApproval(owner, spender, amount, options?)` | `string, string, bigint, ApprovalOptions?` | `Promise<ApprovalUpdate>` | Set an allowance explicitly; no transaction when it already equals the target; simulate non-zero direct writes first, fall back to approve(0) only when needed, and safely follow wallet fee-bumps |

### 9.3 Utility Functions

```typescript
// Amount format conversion
import { parseUnits, formatUnits } from 'goatflow-sdk'

// Human readable → Wei
const amountWei = parseUnits('100.5', 6) // 100500000n

// Wei → Human readable
const amount = formatUnits(100500000n, 6) // "100.5"
```

### 9.4 QuickPay Public API and CLI

QuickPay exposes public, credential-less endpoints for browser payers, CLIs, and agents.

| Surface | Endpoint | Purpose |
|---------|----------|---------|
| Discovery | `GET /quickpay/v1/merchants/{merchant_id}` | Public merchant payment capability |
| Agent instructions | `GET /quickpay/{merchant_id}/agent.md` | Prompt-injection-hardened agent guide |
| Machine manifest | `GET /quickpay/{merchant_id}/manifest.json` | `goatx402.quickpay.v1` manifest |
| Create x402 session | `POST /quickpay/v1/x402/sessions` | Create or reuse a payable QuickPay session |
| Query x402 session | `GET /quickpay/v1/x402/sessions/{session_id}` | Poll public session status |

Session creation request:

```json
{
  "merchant_id": "merchant_123",
  "payer_addr": "0xUserWalletAddress",
  "chain_id": 137,
  "token_contract": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "amount_wei": "10000000",
  "memo": "invoice-123",
  "idempotency_key": "invoice-123:user-456"
}
```

When the session is payable, the response includes an embedded `x402` object with the same `x402Version: 2`, `accepts[0].network = eip155:<id>`, `scheme = exact`, `amount`, `asset`, and `payTo` fields described in Section 6.3.

For a fixed-price product, send `product_key` instead of `amount_wei`. The
server computes the atomic amount from the product's token-agnostic decimal price
and the selected token decimals.

QuickPay package and CLI:

```bash
npx goatflow-quickpay inspect https://flow-api.goat.network/quickpay/merchant_123/agent.md
npx goatflow-quickpay pay-x402 https://flow-api.goat.network/quickpay/merchant_123/agent.md \
  --amount 10 --token-contract 0xToken --chain 137 --idempotency-key invoice-123
npx goatflow-quickpay pay-product https://flow-api.goat.network/quickpay/merchant_123/agent.md \
  --product mug --token-contract 0xToken --chain 137
npx goatflow-quickpay pay-mpp https://flow-api.goat.network/quickpay/merchant_123/agent.md \
  --route <route_canonical>
```

The library exports `QuickPayClient`, `inspect`, `payX402`, `payProduct`,
`payMpp`, `loadManifest`, and `EthersPaymentBackend`.

### 9.5 Hosted Checkout

For a platform-hosted payment page, use `goatflow-checkout`:

```typescript
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })
goat.open({ merchant: 'merchant_123', productKey: 'mug' })
```

Dynamic DIRECT and every DELEGATE checkout start on the backend:

```typescript
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_123',
})

// Browser:
goat.open({ checkoutId: session.checkoutId })
```

DELEGATE supports cross-chain decimal `price` mode and the compatibility
single-chain `fixedAmountWei` mode. Fulfill from
`quickpay.checkout.completed`, never from the browser callback alone. See
[Hosted Checkout](x402-checkout.md).

### 9.6 Type Definitions

```typescript
// Payment flow types
type PaymentFlow =
  | 'ERC20_DIRECT'        // Direct mode
  | 'ERC20_3009'          // Delegate mode (EIP-3009)
  | 'ERC20_APPROVE_XFER'  // Delegate mode (Permit2)

// Order status
type OrderStatus =
  | 'CHECKOUT_VERIFIED'   // Awaiting payment
  | 'PAYMENT_CONFIRMED'   // Payment confirmed
  | 'INVOICED'            // Complete
  | 'EXPIRED'             // Expired
  | 'FAILED'              // Failed
  | 'CANCELLED'           // Cancelled before payment

// Server SDK order interface
interface ServerOrder {
  orderId: string
  flow: PaymentFlow
  tokenSymbol: string
  tokenContract: string
  payToAddress: string
  fromChainId: number
  payToChainId: number
  amountWei: string
  expiresAt: number
  calldataSignRequest?: CalldataSignRequest
}

// Frontend SDK order interface
interface Order extends Omit<ServerOrder, 'fromChainId' | 'payToChainId'> {
  fromAddress: string
  chainId: number
}

function toClientOrder(order: ServerOrder, fromAddress: string): Order {
  return { ...order, fromAddress, chainId: order.fromChainId }
}

// Payment result
interface PaymentResult {
  success: boolean
  txHash?: string
  error?: string
}
```

---

## 10. Error Handling & Troubleshooting

### 10.1 Common Error Codes

| Error Code | Description | Solution |
|------------|-------------|----------|
| `400` | Request parameter or business rule error, including insufficient fee balance or duplicate `dappOrderId` | Check parameter format, fee balance, and uniqueness |
| `401` | Authentication failed | Check API Key/Secret and signature |
| `402` | Payment Required x402 challenge from successful order creation | Treat as expected order creation response |
| `404` | Order not found | Check order ID |
| `503` | QuickPay session creation temporarily unavailable | Retry after the merchant restores fee/config availability |

### 10.2 Frontend Common Issues

#### Issue 1: Fee Balance Insufficient (HTTP 400)

```typescript
try {
  const order = await client.createOrder(params)
} catch (error) {
  if (error.status === 400 && error.message?.includes('insufficient fee balance')) {
    // Display prompt
    alert('Merchant fee balance insufficient, please contact admin to topup')
  }
}
```

#### Issue 2: User Rejected Transaction

```typescript
try {
  const result = await payment.pay(order)
} catch (error) {
  if (error.code === 'ACTION_REJECTED') {
    console.log('User cancelled transaction')
  }
}
```

#### Issue 3: Token Balance Insufficient

```typescript
const balance = await payment.getTokenBalance(order.tokenContract)
const required = BigInt(order.amountWei)

if (balance < required) {
  const token = new ERC20Token(order.tokenContract, provider)
  const symbol = await token.symbol()
  const decimals = await token.decimals()

  alert(`Insufficient balance: need ${formatUnits(required, decimals)} ${symbol}`)
}
```

#### Issue 4: Network Mismatch

```typescript
const network = await provider.getNetwork()
if (Number(network.chainId) !== order.chainId) {
  try {
    await provider.send('wallet_switchEthereumChain', [
      { chainId: `0x${order.chainId.toString(16)}` },
    ])
  } catch (error) {
    alert('Please switch to correct network')
  }
}
```

#### Issue 5: Order Expired

```typescript
if (Date.now() / 1000 > order.expiresAt) {
  alert('Order expired, please create a new one')
  // Create new order
}
```

### 10.3 Debug Checklist

```typescript
async function debugPayment(order: Order) {
  console.log('=== Payment Debug ===')

  // 1. Wallet connection
  const address = await payment.getAddress()
  console.log('Wallet address:', address)

  // 2. Network check
  const network = await provider.getNetwork()
  console.log('Current network:', network.chainId)
  console.log('Order network:', order.chainId)
  console.log('Network match:', Number(network.chainId) === order.chainId)

  // 3. Order validity
  const now = Date.now() / 1000
  console.log('Current time:', now)
  console.log('Expiration:', order.expiresAt)
  console.log('Order valid:', now < order.expiresAt)

  // 4. Token balance
  const balance = await payment.getTokenBalance(order.tokenContract)
  console.log('Token balance:', balance.toString())
  console.log('Required amount:', order.amountWei)
  console.log('Sufficient:', balance >= BigInt(order.amountWei))

  // 5. Payment mode
  console.log('Payment mode:', order.flow)
  console.log('Pay to address:', order.payToAddress)
  console.log('Signature required:', !!order.calldataSignRequest)

  console.log('=== Debug Complete ===')
}
```

---

## 11. Versioning & Compatibility

### 11.1 SDK Versions

Use the package manifests as the version source of truth:

| Package | Source |
|---------|--------|
| `goatflow-sdk` | `goatx402-sdk/package.json` |
| `goatflow-sdk-server` | `goatx402-sdk-server-ts/package.json` |
| `goatflow-checkout` | `goatx402-checkout/package.json` |
| `goatflow-quickpay` | `goatx402-quickpay/package.json` |

### 11.2 Dependency Versions

| Dependency | Version Requirement |
|------------|---------------------|
| ethers | ^6.9.0 |
| typescript | ^5.3.0 |
| node | >=18 |

### 11.3 Browser Compatibility

| Browser | Minimum Version |
|---------|-----------------|
| Chrome | 80+ |
| Firefox | 75+ |
| Safari | 14+ |
| Edge | 80+ |

---

## 12. Best Practices

### 12.1 Backend Best Practices

```typescript
// ✅ Use environment variables
const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL,
  apiKey: process.env.GOATX402_API_KEY,
  apiSecret: process.env.GOATX402_API_SECRET,
})

// ✅ Validate order amount
function validateAmount(amount: string, minUsd: number, maxUsd: number) {
  const value = parseFloat(amount)
  if (value < minUsd || value > maxUsd) {
    throw new Error(`Amount must be between $${minUsd} - $${maxUsd}`)
  }
}

// ✅ Handle Webhook notifications
app.post('/webhook/goatx402', async (req, res) => {
  const { orderId, status, txHash } = req.body

  // Verify signature
  if (!verifyWebhookSignature(req)) {
    return res.status(401).send('Invalid signature')
  }

  // Update order status
  await updateOrderStatus(orderId, status)

  res.status(200).send('OK')
})
```

### 12.2 Frontend Best Practices

```typescript
// ✅ Cache Provider and Signer
let cachedPayment: PaymentHelper | null = null

async function getPaymentHelper() {
  if (!cachedPayment) {
    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer = await provider.getSigner()
    cachedPayment = new PaymentHelper(signer)
  }
  return cachedPayment
}

// ✅ Display user-friendly errors
function getErrorMessage(error: any): string {
  if (error.code === 'ACTION_REJECTED') return 'You cancelled the transaction'
  if (error.message?.includes('insufficient')) return 'Insufficient balance'
  if (error.status === 400 && error.message?.includes('insufficient fee balance')) return 'Merchant fee balance insufficient'
  return 'Payment failed, please try again'
}

// ✅ Transaction status tracking
function PaymentStatus({ txHash, chainId }: { txHash: string, chainId: number }) {
  const explorerUrl = getExplorerUrl(chainId, txHash)
  return (
    <a href={explorerUrl} target="_blank">
      View transaction details
    </a>
  )
}
```

### 12.3 Security Best Practices

```typescript
// ✅ Get order from backend, don't construct on frontend
const order = await fetch('/api/orders', {
  method: 'POST',
  body: JSON.stringify({ productId }),
}).then(r => r.json())

// ✅ Validate order expiration
if (Date.now() / 1000 > order.expiresAt) {
  throw new Error('Order expired')
}

// ✅ Validate payer address
if (order.fromAddress.toLowerCase() !== userAddress.toLowerCase()) {
  throw new Error('Order address mismatch')
}

// ❌ Don't hardcode amounts on frontend
const order = { amountWei: '1000000' } // Dangerous!

// ❌ Don't store sensitive info
localStorage.setItem('apiSecret', secret) // Dangerous!
```

---

## 13. Appendix

### 13.1 Example Project Structure

```
my-payment-app/
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   └── orders.ts       # Order API
│   │   ├── services/
│   │   │   └── goatx402.ts      # GOAT Flow service
│   │   └── index.ts
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── hooks/
│   │   │   └── usePayment.ts   # Payment Hook
│   │   ├── components/
│   │   │   └── PayButton.tsx   # Pay Button
│   │   └── App.tsx
│   └── package.json
└── README.md
```

### 13.2 Token Contract Addresses

| Token | Chain | Contract Address |
|-------|-------|------------------|
| USDC | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDC | Polygon | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` |
| USDT | Ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| USDT | Polygon | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` |

### 13.3 Chain RPC Configuration

```typescript
const CHAIN_RPCS: Record<number, string> = {
  1: process.env.RPC_ETHEREUM!,
  137: process.env.RPC_POLYGON!,
  56: process.env.RPC_BSC!,
  42161: process.env.RPC_ARBITRUM!,
  10: process.env.RPC_OPTIMISM!,
  43114: process.env.RPC_AVALANCHE!,
  8453: process.env.RPC_BASE!,
  80094: process.env.RPC_BERACHAIN!,
  196: process.env.RPC_X_LAYER!,
  2345: process.env.RPC_GOAT!,
  1088: process.env.RPC_METIS!,
  4217: process.env.RPC_TEMPO!,
}
```

---

## 14. Gaps & TODOs

### 14.1 Documentation Gaps

| Content | Priority |
|---------|----------|
| Complete Demo Project | High |
| Webhook Integration Guide | High |
| Go SDK Detailed Docs | Medium |
| Production Chain Configuration | Medium |

### 14.2 SDK Features TODO

| Feature | Status |
|---------|--------|
| Order Status Polling | Available through `getOrderStatus()` and `waitForConfirmation()` |
| WebSocket Real-time Notifications | ⏳ |
| Batch Payments | ⏳ |

---

*Last verified against the repository implementation: 2026-06-26*
