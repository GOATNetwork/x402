# goatx402-checkout

Framework-free browser SDK for GoatX402 hosted checkout. It opens the
platform-controlled payment page in a top-level popup, tab, or full-page redirect;
wallet connection and payment happen there, not in the merchant page.

See the public [Hosted Checkout guide](../docs/x402-checkout.md) for the complete
DIRECT/DELEGATE flow and server SDK examples.

## Install

```bash
npm install goatx402-checkout
```

The package also builds a browser IIFE for script-tag delivery:

```html
<script src="https://pay.goat.network/sdk/checkout.js"></script>
```

## DIRECT product checkout

A QuickPay-enabled DIRECT merchant can open a server-priced product without a
merchant backend. The browser carries the product key, never the amount.

```ts
import { GoatCheckout } from 'goatx402-checkout'

const goat = GoatCheckout({ origin: 'https://pay.goat.network' })

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

## Unified Checkout Session

Dynamic DIRECT checkout and all DELEGATE checkout start on the merchant backend.
Create a server-authoritative session with `goatx402-sdk-server`, return only the
opaque `checkoutId` to the browser, then open it with this package:

```ts
goat.open({
  checkoutId: session.checkoutId,
  display: 'tab',
  onSuccess: (result) => {
    // Confirm fulfillment with quickpay.checkout.completed.
  },
})

// Full-page alternative:
goat.redirectToCheckout({ checkoutId: session.checkoutId })
```

The hosted page reads the session and determines whether it is DIRECT or DELEGATE.
The old `openDelegate({ handle })` and
`redirectToDelegateCheckout({ handle })` methods remain as deprecated aliases for
one compatibility cycle.

## Payment modes and amount integrity

| Browser call | Price source | Backend | Intended use |
| --- | --- | --- | --- |
| `open({ merchant, productKey })` | QuickPay product configured server-side | No | Fixed DIRECT catalog item |
| `open({ checkoutId })` | HMAC-created Checkout Session | Yes | Dynamic DIRECT or any DELEGATE checkout |
| `openCustom({ merchant, amount })` | Browser-supplied amount | No | Donation/custom payment only |

`openCustom` is deliberately untrusted. Never auto-fulfill a purchase from its
browser amount; reconcile the confirmed amount server-side.

### DELEGATE session forms

The unified server endpoint supports:

- cross-chain decimal-price mode: `checkoutType: 'DELEGATE'` plus `price`;
  Core derives the callback chain and payable source-chain/token candidates from
  merchant configuration;
- legacy single-chain fixed-wei mode: `fixedAmountWei`, `chainId`, and
  `acceptableTokens`, with optional callback calldata.

DELEGATE is not a zero-backend flow. The merchant API secret stays on the backend,
which creates the session over HMAC. The buyer may then sign the returned EIP-712
callback authorization, transfer the selected token, and wait for platform
settlement.

## Security and delivery

- The configured `origin` is the trust anchor. It must be HTTPS, except loopback
  HTTP for local development, and must not include a path, query, or credentials.
- `display: 'popup'` and `display: 'tab'` use a hardened `postMessage` channel
  validated by exact origin, exact window source, and a per-open random nonce.
- `onSuccess` is only a UX event. Fulfill from
  `quickpay.checkout.completed` (or a verified order-status query).
- Redirect URLs are honored only when allowed by the merchant's redirect allowlist.
- A strict `Cross-Origin-Opener-Policy` can sever the popup channel; use redirect
  mode when `onError('opener_unavailable')` is reported.

The default server-created-session path is `/checkout`. Product/custom QuickPay
uses `/quickpay/checkout`; deployments with a different hosted route can set
`checkoutPath` and `quickpayCheckoutPath`.

## Develop

```bash
pnpm install
pnpm build
pnpm test:run
pnpm typecheck
```

The tests cover URL validation, popup/tab lifecycle, exact message-channel checks,
settle/cancel races, superseded opens, and deprecated alias behavior.
