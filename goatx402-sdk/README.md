# goatflow-sdk

Frontend TypeScript SDK for **GOAT Flow** payment integration, built on
[ethers v6](https://docs.ethers.org/v6/). It handles the wallet side of a
payment: ERC20 operations, EIP-712 signing, payment execution, and the MPP
(Machine Payments Protocol) buyer flow.

> **This SDK does NOT handle API authentication.** Order creation requires an
> API key/secret that must never reach the browser — use
> [`goatflow-sdk-server`](https://github.com/GOATNetwork/x402/tree/main/goatx402-sdk-server-ts)
> on your backend to create orders, then hand the order to this SDK for payment.

## Install

```bash
npm install goatflow-sdk
```

## Quick start

```typescript
import { PaymentHelper } from 'goatflow-sdk'
import { ethers } from 'ethers'

// Connect wallet
const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()
const payment = new PaymentHelper(signer)

// Get an order from YOUR backend (created there with goatflow-sdk-server)
const order = await fetch('/api/orders', {
  method: 'POST',
  body: JSON.stringify({ /* ... */ }),
}).then((r) => r.json())

// Execute the payment
const result = await payment.pay(order)
if (result.success) {
  console.log('Payment successful:', result.txHash)
}
```

## MPP (Machine Payments Protocol)

```typescript
import { MPPClient } from 'goatflow-sdk'

const mpp = new MPPClient({ coreUrl: 'https://core.example.com', signer })
const result = await mpp.pay({
  merchantId: 'acme',
  routeCanonical: 'GET:api:data',
})
```

The client runs the challenge → pay → verify flow, retries safely, and
recovers from wallet fee-bump replacements. Failures carry an `MPPError` with
a machine-readable code and, where possible, the transaction context needed to
resume verification without paying twice.

## ERC20 approvals

`PaymentHelper.approveToken` / `ERC20Token.setApproval` / `ERC20Token.ensureApproval`:

- **Exact amounts by default.** Unlimited approval is an explicit opt-in via
  `{ unlimited: true }` — a truthy non-boolean is rejected at runtime.
- **No wasted transactions.** Nothing is sent when the allowance already
  equals the requested value; `ensureApproval` leaves a sufficient allowance
  untouched.
- **USDT-style compatibility, probe-first.** Changing a non-zero allowance
  first simulates the direct write with a free `eth_call`: standard ERC20s
  get a single approval — no reset, no transient zero-allowance window. Only
  tokens that reject non-zero → non-zero transitions (USDT-style, or
  providers without simulation support) fall back to a confirmed `approve(0)`
  reset first; if the final approval afterwards fails or is rejected in the
  wallet, the allowance remains zero — re-run the call to re-submit.
- **Fee-bump safe.** A wallet-repriced replacement of the same approve call is
  followed and accepted; a cancellation or a same-nonce transaction with
  different calldata stays a failure.
- **Validated inputs.** Amounts must be non-negative `bigint`s within uint256
  and options must be an object, checked before any transaction — so
  plain-JavaScript callers can't zero an allowance and then fail to encode.

## Requirements

- Node.js >= 18 (when used outside a browser).
- Browsers: Chrome 80+, Firefox 75+, Safari 14+, Edge 80+.

## Documentation

Full integration guide (Chinese + English), API tables, and flow diagrams:
[`docs/Integration.md`](https://github.com/GOATNetwork/x402/blob/main/goatx402-sdk/docs/Integration.md).
Release notes: [`CHANGELOG.md`](./CHANGELOG.md).

## License

MIT
