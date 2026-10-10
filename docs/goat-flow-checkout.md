# GOAT Flow Hosted Checkout

Hosted Checkout is the recommended browser integration when a merchant does not
want to build wallet connection, buyer-transfer UI, session polling, and
completion UX inside its own application.

The browser package is `goatflow-checkout`. It opens a GOAT Flow-hosted, top-level
checkout page; the server packages create authenticated Checkout Sessions.

## Choose the right path

| Use case | Recommended path | Merchant backend required |
| --- | --- | --- |
| Fixed catalog item with configured Crypto and/or Card | QuickPay product + `open({ merchant, productKey })` | No |
| Direct Card payment link | PayKit Card-link creation + hosted payer action | No merchant API secret |
| Dynamic DIRECT cart/amount | Unified Checkout Session + `open({ checkoutId })` | Yes |
| Dynamic card payment | Fiat-enabled Checkout Session + hosted payer action | Yes |
| Donation or buyer-entered amount | `openCustom({ merchant, amount })` | No, but server-side reconciliation is required |
| Fully custom wallet/order UI | `goatflow-sdk` + `goatflow-sdk-server` | Yes |

Do not use `openCustom` for automatic fulfillment. Its amount originates in the
browser and is not a merchant-authoritative price.

## Install

```bash
npm install goatflow-checkout@0.2.0

# Backend, when creating Checkout Sessions:
npm install goatflow-sdk-server@0.4.0
```

The checkout package is framework-free and includes
`dist/checkout.global.js` for self-hosted script-tag delivery through the global
`GoatCheckout` function. The Mainnet QuickPay origin does not currently expose a
public `/sdk/checkout.js`; use the npm import unless your deployment contract
provides a script URL.

In published version `0.2.0`, session opens default to `/paykit/direct`, or
`/paykit/delegate` with `checkoutType: 'DELEGATE'`; the hosted `/checkout?cs=`
route remains a compatibility alias. Set `checkoutSessionPath` to override
session routing. `checkoutPath` retains its legacy product/custom meaning;
those opens default to `/quickpay/checkout`. See
[published package status](README.md#npm-packages).

<a id="fixed-crypto-product-no-merchant-backend"></a>

## Fixed product, no merchant backend

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

`open({ merchant, productKey })` opens the Product payment page. The hosted page
resolves the product's server-side price and offers Crypto, Card, or both
according to the merchant and Product configuration. For Crypto, the buyer
chooses an eligible chain/token; for Card, the buyer completes hosted card
payment. The browser never supplies the product amount.

PayKit's `createFiatCheckoutLink()` or `create-card-checkout` is another way to
create a Card payment link directly without a merchant API secret.

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

Set `GOATX402_API_URL` and the merchant credentials for the deployment you will
use. The browser Checkout origin must belong to that same deployment.

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

### TypeScript: card checkout

The following uses the Testnet3 API. Before testing a card, confirm that this
deployment uses Stripe test mode and that the test merchant is fiat-enabled
with an active connected Stripe account.

```ts
import { GoatFlowClient } from 'goatflow-sdk-server'

const client = new GoatFlowClient({
  baseUrl: 'https://flow-api.testnet3.goat.network',
  apiKey: process.env.GOATX402_API_KEY!,
  apiSecret: process.env.GOATX402_API_SECRET!,
})

const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  paymentRails: ['fiat'],
  fiatCurrency: 'USD',
  fiatAmount: '9.99',
  clientReferenceId: 'your-persisted-payment-intent-id',
})

// Save session.checkoutId, session.url, and the business reference on the
// backend. Return the hosted URL or opaque ID to the browser.
```

Creating this session is not payment confirmation. The payer must enter card
details and finish the hosted flow. A fiat-only session omits crypto `price`.
A session offering both `crypto` and `fiat` supplies `price` as well as the
fiat currency and amount; neither value is converted into the other. Product
checkout must also have the fiat rail enabled for that product.

`checkoutType: 'DIRECT'` chooses the checkout subsystem; `paymentRails` chooses
the methods offered. Card sessions can therefore use `DIRECT`. The current Go
SDK helper does not expose these three Card fields; see the
[Go limitation](./goat-flow-api-reference.md#9-hosted-checkout-sessions).

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
This example uses the Testnet3 Checkout origin to match the Card example above.
For a session created with the Mainnet API, use
`https://flow-quickpay.goat.network` instead. Keep the API, merchant credentials,
and Checkout origin in the same deployment.

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.testnet3.goat.network' })

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
2. The buyer opens the opaque checkout URL.
3. The hosted page reads safe session terms and displays the rails enabled for
   the session.
4. For Crypto, the buyer connects a wallet, chooses an eligible token, and the
   wallet sends the ERC-20 transfer directly to the merchant receiving address.
5. For Card, the buyer enters card details and completes the hosted provider
   flow; no crypto wallet or gas is required from that payer.
6. GOAT Flow records the rail-specific result and may emit the authenticated
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

`clientReferenceId` protects the merchant's business intent, but it is not a
lookup API: creating another session with the same non-empty reference for the
same merchant returns a conflict and does not return the original opaque handle
or URL. Persist `checkoutId` and `url` from the first successful response. After
an ambiguous timeout, reconcile the original record; do not invent a new
reference and create a second payable session automatically. The public server
SDK has no lookup by `clientReferenceId`; if the response was lost, use merchant
records or deployment support rather than fabricating such an endpoint.

Nested create fields (`acceptableTokens`, `lineItems`, `publicMetadata`, and
`privateMetadata`) are JSON-stringified by the server SDK before HMAC signing
because the current signing format accepts scalar fields.
Do not reproduce that encoding manually when an SDK is available.

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
- [PayKit payer/agent library](../goatx402-quickpay/README.md)
