# GOAT Flow Developer Guide (Concise)

## 1. Goal
A minimal integration guide for merchants, covering:
- create order
- frontend payment execution
- callback calldata signature
- error handling
- fee and order cancellation
- frontend SDK and server SDKs (TS / Go)

---

## 2. Integration Boundaries
- Frontend (`goatflow-sdk`): wallet signing and token transfer only (EVM).
- Backend (TS package `goatflow-sdk-server` / [Go source module](goatx402-sdk-server-go/README.md)): call GOAT Flow Core APIs (HMAC authenticated). The Go module currently requires a local `replace`.
- Core: auth verification, order creation, fee charge, on-chain payment watching, state transition, proof issuance.

**Security baseline:** `API_KEY` / `API_SECRET` must only exist on backend, never in frontend.

---

## 3. Unified Environment Variables
Use this naming convention:

```bash
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
GOATX402_MERCHANT_ID=your_merchant_id
```

Note: `GOATX402_BASE_URL` in old docs has the same meaning as `GOATX402_API_URL`. Prefer `GOATX402_API_URL`.

---

## 3.1 Recommended Browser Path: Hosted Checkout

Use `goatflow-checkout` when the platform-hosted page should own wallet connection
and payment UX:

```bash
pnpm install goatflow-checkout
```

A fixed DIRECT QuickPay product can open without a merchant backend:

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })
goat.open({ merchant: 'merchant_123', productKey: 'mug' })
```

Dynamic DIRECT and all DELEGATE checkout must be created on the backend:

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_123',
})

// Browser:
goat.open({ checkoutId: session.checkoutId })
```

For cross-chain DELEGATE use `checkoutType: 'DELEGATE'` with `price`; Core
derives eligible source-chain/token candidates and the fixed callback chain. The
legacy single-chain form uses `chainId`, `fixedAmountWei`, and
`acceptableTokens`.

Browser callbacks are UX-only. Fulfill from `quickpay.checkout.completed` or a
trusted backend status check. Full guide: `docs/x402-checkout.md`.

---

## 4. Core Flow
1. Frontend requests your backend to create an order.
2. Backend calls `POST /api/v1/orders` (Server SDK).
3. Core returns x402 response (**HTTP 402 is success**), backend returns normalized `Order` to frontend.
4. If `order.calldataSignRequest` exists, frontend signs first and sends signature to backend.
5. Backend calls `POST /api/v1/orders/{id}/calldata-signature`.
6. Frontend calls `payment.pay(order)` and transfers to `order.payToAddress`.
7. Backend polls order status and fetches proof after confirmation.
8. Cancel unused orders in time (`CHECKOUT_VERIFIED` can be cancelled and refunded).

**Key fact:** For all flows, user-side action is transfer to `payToAddress`. `ERC20_3009/APPROVE_XFER` is Core's settlement mechanism, not frontend "auto gasless payment".

---

## 5. Frontend SDK (`goatflow-sdk`)
Install:

```bash
pnpm install goatflow-sdk ethers
```

Example:

```ts
import { PaymentHelper } from 'goatflow-sdk'
import { ethers } from 'ethers'

const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()
const payment = new PaymentHelper(signer)

// order comes from your backend
if (order.calldataSignRequest) {
  const signature = await payment.signCalldata(order)
  await fetch(`/api/orders/${order.orderId}/signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature }),
  })
}

const result = await payment.pay(order)
if (!result.success) {
  console.error(result.error)
}
```

Notes:
- `goatflow-sdk` depends on `ethers` and is an EVM SDK.

---

## 6. Server SDK (TypeScript)
Install:

```bash
pnpm install goatflow-sdk-server
```

Initialize:

```ts
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL!,
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})
```

Create order:

```ts
const order = await client.createOrder({
  dappOrderId: `order_${Date.now()}`,
  chainId: 137,
  tokenSymbol: 'USDC',
  tokenContract: '0x...',
  fromAddress: '0xUser',
  amountWei: '1000000',
  // callbackCalldata: '0x...' // DELEGATE + callback scenario
})
```

Submit calldata signature:

```ts
await client.submitCalldataSignature(order.orderId, signature)
```

Poll status / get proof / cancel:

```ts
const status = await client.getOrderStatus(order.orderId)

if (status.status === 'PAYMENT_CONFIRMED') {
  const proof = await client.getOrderProof(order.orderId)
}

await client.cancelOrder(order.orderId) // only cancellable in CHECKOUT_VERIFIED
```

---

## 7. Server SDK (Go)

The Go SDK is source-only and is not available from a standalone module
repository. Clone the public repository next to your application:

```bash
git clone https://github.com/GOATNetwork/x402.git
```

Add this to your application's `go.mod`, adjusting the relative path if needed:

```go
require github.com/goatnetwork/goatflow-sdk-server v0.0.0

replace github.com/goatnetwork/goatflow-sdk-server => ../x402/goatx402-sdk-server-go
```

Run `go mod tidy`. See the [Go SDK source instructions](goatx402-sdk-server-go/README.md)
for details.

Example:

```go
import goatflow "github.com/goatnetwork/goatflow-sdk-server"

client := goatflow.NewClient(goatflow.Config{
  BaseURL:   os.Getenv("GOATX402_API_URL"),
  APIKey:    os.Getenv("GOATX402_API_KEY"),
  APISecret: os.Getenv("GOATX402_API_SECRET"),
})

order, err := client.CreateOrder(ctx, goatflow.CreateOrderParams{
  DappOrderID: "order_123",
  ChainID: 137,
  TokenSymbol: "USDC",
  TokenContract: "0x...",
  FromAddress: "0xUser",
  AmountWei: "1000000",
})
if err != nil {
  if apiErr, ok := err.(*goatflow.APIError); ok {
    log.Printf("status=%d message=%s", apiErr.Status, apiErr.Message)
  }
}

status, _ := client.GetOrderStatus(ctx, order.OrderID)
_ = status
```

---

## 8. Callback Signature (DELEGATE)
When `callbackCalldata` is sent during order creation and merchant config is valid, Core returns `calldataSignRequest`:

1. Frontend calls `payment.signCalldata(order)` to generate user signature.
2. Backend submits signature to `/api/v1/orders/{id}/calldata-signature`.
3. Frontend executes `payment.pay(order)`.

**Do not hardcode EIP-712 domain/type on frontend.** Always use `calldataSignRequest` returned in the order.

---

## 9. Callback Contract Setup (`MerchantCallback`)
Recommended deployment via repository script (Upgradeable + Proxy):

```bash
cd goatx402-contract
PRIVATE_KEY=<OWNER_KEY> forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url <DESTINATION_CHAIN_RPC> \
  --broadcast
```

Merchant setup by GOAT Flow:

Send the following fields to GOAT Flow for merchant setup:
- `merchant_id`
- `chain_id`
- `spent_address`
- `eip712_name`
- `eip712_version`

Notes:
- The deploy script reads the deployer key from the `PRIVATE_KEY` environment variable.
- `eip712_name` and `eip712_version` are required in callback signature flow.
- Add GOAT Flow authorized caller (`x402d`) to callback contract allowlist.

---

## 10. Error Codes (from `goatx402-core`)
For Core public APIs, HTTP status can be treated as error code:

| HTTP | Meaning | Common Triggers |
| --- | --- | --- |
| 400 | Request validation / business rule failure | missing fields, invalid address, unsupported token, insufficient fee, invalid signature format, non-cancellable status |
| 401 | Authentication failure | missing/invalid `X-API-Key` / `X-Timestamp` / `X-Nonce` / `X-Sign`; `nonce` must be included in the signed params |
| 403 | Authorization failure | merchant mismatch, order not owned by current merchant |
| 404 | Resource not found | merchant/order/proof not found |
| 500 | Internal server error | Core internal exception |

**Important:** `POST /api/v1/orders` returns **402 Payment Required** on success (x402 protocol), not a failure.

Error body may use `error` or `message`. Handle both.

---

## 11. Fee and Order Cancellation
- Fee is charged when creating an order.
- If order will not continue, cancel quickly (`CHECKOUT_VERIFIED` required).
- After cancel, Core releases reserved amount and refunds order fee.
- In Core expiration path, expired orders also release reservation and refund fee.

Recommended practices:
1. Cancel from backend when frontend times out/user closes payment page.
2. Add scheduled cleanup on backend for long-unpaid orders.
3. Alert on `insufficient fee balance` to avoid checkout outage.

---

## 12. Flow Quick Reference
| Flow | User Transfer Target | Description |
| --- | --- | --- |
| `ERC20_DIRECT` | merchant address | direct payment |
| `ERC20_3009` | TSS address | user pays TSS first, Core settles via EIP-3009 |
| `ERC20_APPROVE_XFER` | TSS address | user pays TSS first, Core settles via Permit2 |

---

## 13. Minimum Go-Live Checklist
1. Store and isolate `API_SECRET` on backend only.
2. Add monitoring for `insufficient fee balance`.
3. Auto-cancel stale `CHECKOUT_VERIFIED` orders.
4. Verify order-status polling and proof retrieval flow.
5. Validate DELEGATE + callback `calldataSignRequest` signature submission flow.
6. For Hosted Checkout, subscribe to `quickpay.checkout.completed` and never
   fulfill from the browser callback alone.
