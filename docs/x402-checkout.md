# GOAT Flow Hosted Checkout

Hosted Checkout is the recommended browser integration when a merchant does not
want to build wallet connection, payment UI, session polling, and settlement UX
inside its own application.

The browser package is `goatflow-checkout`. It opens a platform-hosted, top-level
checkout page; the server packages create authenticated Checkout Sessions.

## Choose the right path

| Use case | Recommended path | Merchant backend required |
| --- | --- | --- |
| Fixed DIRECT catalog item | QuickPay product + `open({ merchant, productKey })` | No |
| Dynamic DIRECT cart/amount | Unified Checkout Session + `open({ checkoutId })` | Yes |
| DELEGATE checkout | Unified Checkout Session + `open({ checkoutId })` | Yes |
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

The checkout package is framework-free. It can also be delivered as
`https://pay.goat.network/sdk/checkout.js` and used through the global
`GoatCheckout` function.

## Fixed DIRECT product, no merchant backend

The merchant first configures a QuickPay product. The merchant page passes only the
merchant ID and product key:

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })

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
  checkoutType: string
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
    { name: 'Coffee mug', quantity: 1, unit_price: '19.95' },
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

### TypeScript: cross-chain DELEGATE checkout

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DELEGATE',
  price: '19.95',
  clientReferenceId: 'cart_9f31',
  lineItems: [{ name: 'Coffee mug', quantity: 1 }],
})
```

In decimal-price DELEGATE mode, Core derives:

- the fixed callback/settlement chain from the merchant's approved callback
  contract;
- eligible source-chain/token choices from merchant receiving configuration and
  enabled TSS/token capabilities;
- the atomic payment amount from the selected token decimals.

The buyer may therefore pay on an eligible source chain while settlement remains on
the merchant's callback chain.

If `publicMetadata.callback_template` is set, the hosted page uses it to
ABI-encode an optional per-buyer `callback_calldata` at bind time. The template
must have this exact shape (`publicMetadata` is an unstructured object, so the
compiler cannot check it for you):

```ts
publicMetadata: {
  callback_template: {
    // Solidity function signature (a leading "function " prefix is optional)
    signature: 'testCallback(address payer, uint256 value, string message)',
    // STATIC ABI parameters, encoded as-is — there is no runtime substitution,
    // so e.g. a fixed uint256 amount bakes in ONE token-decimals assumption
    args: ['0x0000000000000000000000000000000000000000', '3500000', 'Cotton T-Shirt'],
  },
},
```

A malformed template (missing `signature`, un-encodable `args`) makes the hosted
page throw at encode time and blocks the bind — deliberately, so the buyer is
never silently downgraded to a plain payment the merchant did not intend.

Understand the trust model before relying on it:

- `callback_template` is only an encoding hint for the hosted UI — it is NOT a
  server-enforced constraint.
- Bind-time calldata is buyer-controlled input: the buyer can omit it (the order
  then settles via the plain no-calldata callback method) or substitute different
  bytes, and Core does not re-validate it against the template.
- The callback contract is the on-chain authority: it must validate selectors,
  parameters, and permissions itself, and treat every callable function as
  buyer-reachable.
- If you need server-authoritative calldata (fulfillment that must run exactly as
  pinned), use the legacy fixed-wei form's create-time `callbackCalldata`; price
  mode cannot provide that guarantee.

### TypeScript: legacy fixed-wei DELEGATE checkout

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DELEGATE',
  chainId: 97,
  fixedAmountWei: '1000000',
  acceptableTokens: ['0xTokenContract'],
  callbackCalldata: '0x...', // optional when no calldata callback is needed
  clientReferenceId: 'invoice_123',
})
```

Use this compatibility form only when the merchant intentionally pins one chain and
an atomic token amount. `createDelegateCheckoutSession` remains as a deprecated
wrapper; new integrations should use `createCheckoutSession`.

### Go

The Go server SDK is source-only. First [clone this repository and configure a
local `replace`](../goatx402-sdk-server-go/README.md).

```go
import goatflow "github.com/goatnetwork/goatflow-sdk-server"

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

For DELEGATE cross-chain price mode, set `CheckoutType: "DELEGATE"` and
`Price`. For the legacy fixed-wei form, set `ChainID`,
`FixedAmountWei`, and `AcceptableTokens`.

## Open the session in the browser

Return the opaque `checkoutId` to the browser; never return the API secret.

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })

goat.open({
  checkoutId,
  display: 'tab', // 'popup', 'tab', or 'redirect'
  onSuccess: (result) => {
    // UX only; await webhook/order verification before fulfillment.
  },
  onCancel: () => {},
  onError: (reason) => {
    if (reason === 'opener_unavailable') {
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
5. DIRECT sends the ERC-20 transfer to the merchant payment address.
6. DELEGATE may request an EIP-712 callback signature, then receives the buyer
   transfer at the source TSS wallet and settles to the callback chain.
7. The platform marks the session completed and emits
   `quickpay.checkout.completed`.

Session states are `OPEN`, `BOUND`, `SIGNED` (DELEGATE only),
`COMPLETED`, `EXPIRED`, and `CANCELLED`. The linked order has its own
`CHECKOUT_VERIFIED` → `PAYMENT_CONFIRMED` → `INVOICED` lifecycle.

## API surface

| Endpoint | Auth | Intended caller |
| --- | --- | --- |
| `POST /api/v1/checkout/sessions` | Merchant HMAC | Server SDK |
| `GET /checkout/v1/sessions/{checkout_id}` | Public opaque handle | Hosted checkout |
| `GET /checkout/v1/sessions/{checkout_id}/status` | Public opaque handle | Hosted checkout |
| `POST /checkout/v1/sessions/{checkout_id}/bind` | Public, rate-limited | Hosted checkout |
| `POST /checkout/v1/sessions/{checkout_id}/signature` | Public, rate-limited | Hosted DELEGATE checkout |

Merchant applications normally call only the authenticated create endpoint. The
platform-hosted page owns the public read/bind/signature sequence.

Nested create fields (`acceptableTokens`, `lineItems`,
`publicMetadata`, and `privateMetadata`) are JSON-stringified by the server
SDK before HMAC signing because the current signing format accepts scalar fields.
Do not reproduce that encoding manually when an SDK is available.

## Fulfillment and security

- `onSuccess` and `postMessage` are UX signals, not payment proof.
- Fulfill from the `quickpay.checkout.completed` webhook or a trusted backend
  status check. The webhook carries the checkout type, order ID, completion
  transaction hash, and, when supplied, `client_reference_id`, line items, and
  public metadata.
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
