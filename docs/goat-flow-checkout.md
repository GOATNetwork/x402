# GOAT Flow Hosted Checkout

Hosted Checkout is the recommended browser integration when a merchant does not
want to build wallet connection, buyer-transfer UI, session polling, and
completion UX inside its own application.

The browser package is `goatflow-checkout`. It opens a GOAT Flow-hosted, top-level
checkout page; the server packages create authenticated Checkout Sessions.

If the merchant application wants to keep the buyer inside its own React page,
use the [QuickPay React SDK](./quickpay-react-sdk.md) for Embedded Checkout or
Payment Element.

## Choose the right path

| Use case | Recommended path | Merchant backend required |
| --- | --- | --- |
| Fixed DIRECT catalog item | QuickPay product + `open({ merchant, productKey })` | No |
| Dynamic DIRECT cart/amount | Unified Checkout Session + `open({ checkoutId })` | Yes |
| React embedded checkout block | QuickPay React SDK + checkout-session source | Yes for dynamic sessions |
| React payment-only panel | QuickPay React SDK Payment Element | Yes for dynamic sessions |
| Donation or buyer-entered amount | `openCustom({ merchant, amount })` | No, but server-side reconciliation is required |
| Fully custom wallet/order UI | `goatflow-sdk` + `goatflow-sdk-server` | Yes |

Do not use `openCustom` for automatic fulfillment. Its amount originates in the
browser and is not a merchant-authoritative price.

## Install

```bash
npm install goatflow-checkout

# Backend, when creating Checkout Sessions:
npm install goatflow-sdk-server
```

The checkout package is framework-free and includes
`dist/checkout.global.js` for self-hosted script-tag delivery through the global
`GoatCheckout` function. The Mainnet QuickPay origin does not currently expose a
public `/sdk/checkout.js`; use the npm import unless your deployment contract
provides a script URL.

## Fixed DIRECT product, no merchant backend

The merchant first configures a QuickPay product. The merchant page passes only the
merchant ID and product key:

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })

payButton.addEventListener('click', () => {
  goat.open({
    merchant: 'merchant_123',
    productKey: 'mug',
    display: 'popup',
    clientReferenceId: 'cart_9f31',
    onSuccess: (result) => {
      // Update the UI only. Do not fulfill from this callback.
      console.log(result.status, result.tx_hash)
    },
    onCancel: () => {},
    onError: (reason) => console.error(reason),
  })
})
```

The hosted page resolves the product's server-side decimal price and the buyer
chooses an eligible chain/token. The browser never supplies the product amount.

## Create a unified Checkout Session

`POST /api/v1/checkout/sessions` is HMAC-authenticated. The server SDK signs it
with the merchant API secret and maps the response to:

```ts
type CheckoutSession = {
  checkoutId: string
  checkoutType: string // current values: 'DIRECT' | 'DELEGATE'
  url: string
  expiresAt: number
}
```

The merchant is derived from the authenticated API key, not accepted from the
request body.

### TypeScript: dynamic DIRECT checkout

```ts
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: process.env.GOATX402_API_URL!,
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_9f31',
  lineItems: [
    { name: 'Coffee mug', quantity: 1, amount: '19.95' },
  ],
  publicMetadata: { campaign: 'summer' },
  privateMetadata: { internal_customer_id: 'cus_42' },
  successUrl: 'https://merchant.example/pay/success',
  cancelUrl: 'https://merchant.example/pay/cancel',
  expiresIn: 1800,
})
```

DIRECT Checkout Sessions require the authenticated merchant to be DIRECT and to
have QuickPay enabled.

### Go

```go
session, err := client.CreateCheckoutSession(ctx, goatflow.CreateCheckoutSessionParams{
    CheckoutType:     "DIRECT",
    Price:            "19.95",
    ClientReferenceID: "cart_9f31",
    ExpiresIn:        1800,
})
if err != nil {
    return err
}

// Send session.CheckoutID to the browser, or redirect to session.URL.
```

### Operator-provisioned compatibility reference

The API and SDK retain a compatibility session value for explicitly
operator-provisioned environments. It is not part of public merchant onboarding,
and new integrations use `createCheckoutSession()` with `DIRECT`. Do not infer
availability from SDK types. The complete legacy field mapping, deprecated
wrappers, and callback trust boundary are isolated in the
[API Reference appendix](./goat-flow-api-reference.md#appendix-a-operator-provisioned-callback-compatibility).

## Open the session in the browser

Return the opaque `checkoutId` to the browser; never return the API secret.

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })

let checkoutHandle: { close(): void } | undefined
checkoutHandle = goat.open({
  checkoutId,
  display: 'tab', // 'popup', 'tab', or 'redirect'
  onSuccess: (result) => {
    // UX only; await webhook/order verification before fulfillment.
  },
  onCancel: () => {},
  onError: (reason) => {
    if (reason === 'opener_unavailable') {
      // The popup may still be running; close it before redirecting this page.
      checkoutHandle?.close()
      goat.redirectToCheckout({ checkoutId })
    }
  },
})
```

If session creation requires an asynchronous request after the buyer clicks, either
redirect the current page or synchronously open a blank tab and navigate it after
the response. Calling `window.open` only after an `await` is commonly blocked by
browsers.

## Lifecycle

1. The merchant backend creates a server-authoritative Checkout Session.
2. The buyer opens the opaque checkout URL and connects a wallet.
3. The hosted page reads safe session terms from Core.
4. The buyer chooses an eligible token; bind creates the real order.
5. The buyer wallet sends the ERC-20 transfer directly to the merchant receiving
   address.
6. GOAT Flow records the resulting session state and may emit the authenticated
   completion webhook configured by that deployment.

Known Checkout Session states include `OPEN`, `BOUND`, `SIGNED`
(operator-provisioned compatibility sessions), `COMPLETED`, `EXPIRED`, and
`CANCELLED`. The linked order has a separate status model. Server SDK order
waiters treat `PAYMENT_CONFIRMED` and `INVOICED` as successful terminal states;
Core can advance a DIRECT order to `INVOICED` before a poller observes
`PAYMENT_CONFIRMED`.

## API surface

| Endpoint | Auth | Intended caller |
| --- | --- | --- |
| `POST /api/v1/checkout/sessions` | Merchant HMAC | Server SDK |
| `GET /checkout/v1/sessions/{checkout_id}` | Public opaque handle | Hosted checkout |
| `GET /checkout/v1/sessions/{checkout_id}/status` | Public opaque handle | Hosted checkout |
| `POST /checkout/v1/sessions/{checkout_id}/bind` | Public, rate-limited | Hosted checkout |
| `POST /checkout/v1/sessions/{checkout_id}/signature` | Public, rate-limited | Operator-provisioned hosted compatibility flow |

Merchant applications normally call only the authenticated create endpoint. The
GOAT Flow-hosted page owns the public read/bind/signature sequence.

Nested create fields (`acceptableTokens`, `lineItems`, `publicMetadata`, and
`privateMetadata`) are JSON-stringified by the server SDK before HMAC signing
because the current signing format accepts scalar fields.
Do not reproduce that encoding manually when an SDK is available.

## React embedded surfaces

Hosted Checkout, Embedded Checkout, and Payment Element are UI surfaces.
Checkout sessions, merchant products, and custom amounts are payment sources.

For React applications, pass the same backend-created `checkoutId` to the
QuickPay React SDK:

```tsx
<QuickPayPaymentElement
  source={{ type: 'checkout-session', checkoutId, checkoutType: 'direct' }}
/>
```

The React SDK still uses GOAT Flow session status for payment completion. Host
callbacks are for UI state; fulfillment requires backend status or an
authenticated webhook. See the
[QuickPay React SDK guide](./quickpay-react-sdk.md) for props and examples.

## Fulfillment and security

- `onSuccess` and `postMessage` are UX signals, not payment proof.
- Fulfill from a trusted backend status check or an authenticated webhook whose
  event name, payload, signature, and retry behavior are confirmed for the
  deployment. The public SDKs do not define one canonical webhook event name.
- The raw `cs_…` handle is high entropy. Treat it as a bearer capability, avoid
  logging it, and do not place secrets in public metadata or line items.
- `privateMetadata` is excluded from the public session view.
- Success/cancel URLs must pass the merchant redirect allowlist.
- Popup/tab messages are accepted only from the exact configured origin, exact
  opened window, and matching random channel nonce.
- Hosted checkout must remain a top-level page; do not embed it in an iframe.
- The merchant API key and secret stay exclusively on the backend.

## Related modules

- [Browser SDK](../goatx402-checkout/README.md)
- [Server SDK (TypeScript)](../goatx402-sdk-server-ts/src/client.ts)
- [Server SDK (Go)](../goatx402-sdk-server-go/client.go)
- [Demo](../goatx402-demo/README.md)
- [QuickPay payer/agent library](../goatx402-quickpay/README.md)
