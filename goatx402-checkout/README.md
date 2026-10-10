# goatflow-checkout

Framework-free browser SDK for GOAT Flow hosted checkout. It opens the
GOAT Flow-hosted checkout interface in a top-level popup, tab, or full-page
redirect. Depending on the deployment and merchant/product configuration, the
hosted page can offer a direct ERC-20 transfer or Card. Crypto payers connect a
wallet and need token balance plus native gas; Card payers complete the hosted
card flow and do not need a crypto wallet.

See the public [Hosted Checkout guide](../docs/goat-flow-checkout.md) for the
complete Crypto and Card flow and server SDK examples.

## Install

```bash
npm install goatflow-checkout@0.2.0
```

The package also builds `dist/checkout.global.js` as a browser IIFE for
self-hosted script-tag delivery. Do not assume the file is deployed at a fixed
GOAT Flow URL; use the npm import above unless your deployment contract provides
a script URL.

```html
<script src="/vendor/checkout.global.js"></script>
```

## Crypto Product checkout

The current legacy Crypto Product route lets a QuickPay-enabled DIRECT merchant
open a server-priced stablecoin Product without a merchant backend. The browser
carries the product key, never the amount. This example uses the Mainnet
Checkout origin; use `https://flow-quickpay.testnet3.goat.network` with a
Testnet3 merchant/Product when testing there.

```ts
import { GoatCheckout } from 'goatflow-checkout'

const goat = GoatCheckout({ origin: 'https://flow-quickpay.goat.network' })

button.addEventListener('click', () => {
  goat.open({
    merchant: 'acme',
    productKey: 'mug',
    display: 'popup', // also: 'tab' or 'redirect'
    onSuccess: (result) => {
      // UX signal only; fulfill from the webhook or verified order status.
      console.log(result)
    },
    onCancel: () => {},
    onError: (reason) => {
      if (reason === 'opener_unavailable') {
        // A strict COOP policy severed the popup channel; use redirect mode.
      }
    },
  })
})
```

`open()` must run synchronously inside the user gesture so browsers do not block
the popup or tab.

## Hosted Checkout Session

Dynamic DIRECT checkout starts on the merchant backend. Create a
server-authoritative session with `goatflow-sdk-server`, return only the opaque
`checkoutId` to the browser, then open it with this package:

```ts
goat.open({
  checkoutId: session.checkoutId,
  display: 'tab',
  onSuccess: (result) => {
    // Confirm fulfillment with trusted backend status or a verified webhook.
  },
})

// Full-page alternative:
goat.redirectToCheckout({ checkoutId: session.checkoutId })
```

The hosted page reads the session terms. The server SDK response exposes
`checkoutType` as `string`; public merchant integrations use `DIRECT` and
handle unknown future values explicitly.

## Payment modes and amount integrity

| Browser call | Price source | Backend | Intended use |
| --- | --- | --- | --- |
| `open({ merchant, productKey })` | QuickPay product configured server-side | No | Fixed Crypto catalog item; this legacy direct Product route is stablecoin-only |
| `open({ checkoutId })` | HMAC-created Checkout Session | Yes | Dynamic Crypto and/or Card checkout; operator-provisioned compatibility sessions |
| `openCustom({ merchant, amount })` | Browser-supplied amount | No | Donation/custom payment only |

`openCustom` is deliberately untrusted. Never auto-fulfill a purchase from its
browser amount; reconcile the confirmed amount server-side.

For a Product advertised on the Card rail, use PayKit's
`createFiatCheckoutLink()` or `create-card-checkout` to create the hosted human
payer link. Do not treat link creation as payment confirmation.

`checkoutType` and payment rail are different dimensions: a server-created
`DIRECT` session may offer `crypto`, `fiat`, or both. The browser package opens
the opaque session and does not decide eligibility or amounts. Card enablement,
currency, Stripe mode, and provider status remain deployment and merchant
configuration.

### Compatibility aliases and session variants

The package retains `openDelegate({ handle })` and
`redirectToDelegateCheckout({ handle })` as deprecated aliases for one
compatibility cycle. Server SDK types also retain an operator-provisioned
DELEGATE session value. These are not part of the current public onboarding path;
the merchant API secret remains backend-only, and availability must come from an
explicit deployment contract. See the
[API Reference](../docs/goat-flow-api-reference.md) for the canonical compatibility
fields and signature endpoint.

## Security and delivery

- The configured `origin` is the trust anchor. It must be HTTPS, except loopback
  HTTP for local development, and must not include a path, query, or credentials.
- `display: 'popup'` and `display: 'tab'` use a hardened `postMessage` channel
  validated by exact origin, exact window source, and a per-open random nonce.
- `onSuccess` is only a UX event. Fulfill from verified backend status or an
  authenticated webhook contract confirmed for the deployment; the public SDK
  does not define one canonical webhook event name.
- Redirect URLs are honored only when allowed by the merchant's redirect allowlist.
- A strict `Cross-Origin-Opener-Policy` can sever the popup channel; use redirect
  mode when `onError('opener_unavailable')` is reported.

Server-created sessions default to `/paykit/direct` or `/paykit/delegate`.
Pass `checkoutType: 'DELEGATE'` for the latter; DIRECT is the default.
Use `checkoutSessionPath` to override both session routes, for example
`'/checkout'` when migrating an older hosted deployment. Product/custom
QuickPay keeps `/quickpay/checkout` and the `quickpayCheckoutPath` /
legacy `checkoutPath` configuration.

## Develop

```bash
npm install
npm run build
npm run test:run
npm run typecheck
```

The tests cover URL validation, popup/tab lifecycle, exact message-channel checks,
success/cancel races, superseded opens, and deprecated alias behavior.

See the [Changelog](./CHANGELOG.md).
