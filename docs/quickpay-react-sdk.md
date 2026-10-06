# QuickPay React SDK

The QuickPay React SDK lets a merchant application embed GOAT Flow payment UI
directly in its own React page.

Use this guide when you want a React component instead of only redirecting the
buyer to a hosted checkout page.

## Product Model

QuickPay separates UI surface from payment source.

UI surfaces:

- Hosted Page
- Embedded Checkout
- Payment Element

Payment sources:

- merchant product
- custom amount
- checkout session by `checkoutId`

A checkout session is not a fourth component type. It is a server-created
payment source that can be rendered through Hosted Page, Embedded Checkout, or
Payment Element.

## When To Use Each Surface

| Surface | Use when | Backend required |
| --- | --- | --- |
| Hosted Page | You want GOAT Flow to own the full checkout page. | Only for dynamic checkout sessions. |
| Embedded Checkout | You want a complete checkout block inside your React page. | Only for dynamic checkout sessions. |
| Payment Element | You own the surrounding cart/product UI and want QuickPay to render only payment controls. | Only for dynamic checkout sessions. |

For fixed QuickPay products, the merchant configures the product in GOAT Flow
and the browser passes only the merchant ID and product key. For dynamic carts
or server-priced purchases, create a checkout session on the merchant backend
and pass only its opaque `checkoutId` to the browser.

## Availability

The React package name is:

```bash
npm install @goatx402/quickpay-react
```

Use this install shape only after your team has access to the package version
and release channel for the target environment. Keep Testnet3 and Mainnet
merchant IDs, API origins, chain IDs, and token configuration separate.

## Provider

Wrap embedded QuickPay components with `QuickPayProvider` and import the
stylesheet once:

```tsx
import {
  QuickPayProvider,
  QuickPayEmbeddedCheckout,
} from '@goatx402/quickpay-react'
import '@goatx402/quickpay-react/styles.css'

export function App() {
  return (
    <QuickPayProvider apiBase="https://flow-quickpay.testnet3.goat.network">
      <CheckoutPage />
    </QuickPayProvider>
  )
}
```

`apiBase` points to the QuickPay origin for the target environment. If it is
omitted, the SDK uses same-origin API paths, so the host application must
reverse-proxy `/quickpay/v1`, `/mpp/v1`, and `/checkout/v1` to QuickPay.

For cross-origin `apiBase`, the QuickPay API origin must allow the host
application origin through CORS.

## Hosted Page Link

Use Hosted Page when the buyer should leave the host page or open a QuickPay
checkout window.

```tsx
import { QuickPayHostedPageLink } from '@goatx402/quickpay-react'

export function PayLink() {
  return (
    <QuickPayHostedPageLink
      merchantId="merchant_123"
      productKey="mug"
    >
      Pay with QuickPay
    </QuickPayHostedPageLink>
  )
}
```

For a backend-created checkout session:

```tsx
<QuickPayHostedPageLink
  source={{
    type: 'checkout-session',
    checkoutId,
    checkoutType: 'direct',
  }}
>
  Pay with QuickPay
</QuickPayHostedPageLink>
```

The hosted checkout route reads the checkout session from GOAT Flow and renders
the server-authoritative terms.

## Embedded Checkout

Use Embedded Checkout when the host page should include a complete QuickPay
checkout block, including merchant/product context and payment controls.

```tsx
import {
  QuickPayEmbeddedCheckout,
  QuickPayProvider,
} from '@goatx402/quickpay-react'
import '@goatx402/quickpay-react/styles.css'

export function EmbeddedProductCheckout({ discovery }) {
  return (
    <QuickPayProvider apiBase="https://flow-quickpay.testnet3.goat.network">
      <QuickPayEmbeddedCheckout
        merchantId={discovery.merchant_id}
        discovery={discovery}
        scenario="multiple-products"
      />
    </QuickPayProvider>
  )
}
```

For a backend-created checkout session:

```tsx
<QuickPayEmbeddedCheckout
  source={{
    type: 'checkout-session',
    checkoutId,
    checkoutType: 'direct',
  }}
/>
```

Checkout-session mode uses the session's trusted merchant snapshot, line items,
amount, token options, and status from GOAT Flow.

## Payment Element

Use Payment Element when the host owns the product/cart UI and wants QuickPay
to render only wallet, rail, token, amount, and payment-status controls.

```tsx
import {
  QuickPayPaymentElement,
  QuickPayProvider,
} from '@goatx402/quickpay-react'
import '@goatx402/quickpay-react/styles.css'

export function DonationPayment({ discovery }) {
  return (
    <QuickPayProvider apiBase="https://flow-quickpay.testnet3.goat.network">
      <QuickPayPaymentElement
        merchantId={discovery.merchant_id}
        discovery={discovery}
        paymentMode="custom-amount"
      />
    </QuickPayProvider>
  )
}
```

For host-owned product UI:

```tsx
<QuickPayPaymentElement
  merchantId={discovery.merchant_id}
  discovery={discovery}
  paymentMode="host-price"
  selectedProductKey={productKey}
/>
```

For a backend-created checkout session:

```tsx
<QuickPayPaymentElement
  source={{
    type: 'checkout-session',
    checkoutId,
    checkoutType: 'direct',
  }}
/>
```

In checkout-session mode, the Payment Element renders payment controls for the
server-created session while the host continues to own the surrounding cart UI.

## Checkout Session Source

Create dynamic terms on the merchant backend:

```ts
const session = await client.createCheckoutSession({
  checkoutType: 'DIRECT',
  price: '19.95',
  clientReferenceId: 'cart_123',
  lineItems: [{ name: 'Mug', amount: '19.95', quantity: 1 }],
  successUrl: 'https://merchant.example/pay/success',
  cancelUrl: 'https://merchant.example/pay/cancel',
})
```

Return only `session.checkoutId` to the browser. Keep the API key and secret on
the backend.

The browser then passes:

```tsx
source={{
  type: 'checkout-session',
  checkoutId,
  checkoutType: 'direct',
}}
```

The checkout ID is an opaque bearer capability. Avoid logging it and do not put
secrets in line items or public metadata.

## Events

Embedded components expose callbacks for host UI state:

```tsx
<QuickPayPaymentElement
  source={{ type: 'checkout-session', checkoutId, checkoutType: 'direct' }}
  onPaymentBroadcast={(event) => {
    console.log(event.checkoutId, event.orderId, event.txHash)
  }}
  onStatusChange={(event) => {
    console.log(event.checkoutId, event.status, event.orderStatus)
  }}
  onError={(event) => {
    console.warn(event.code, event.message, event.recoverable)
  }}
  onPaymentSuccess={(event) => {
    console.log(event.checkoutId, event.status, event.clientReferenceId)
  }}
/>
```

Use `onPaymentBroadcast` for pending UI. Use `onPaymentSuccess` for paid UI only
after QuickPay observes a successful terminal status.

Checkout callbacks are still browser UX signals. Fulfill goods or services only
after a trusted backend order/session status check or an authenticated webhook
whose event name, signature, payload, and retry behavior are confirmed for the
deployment.

`QuickPayEventName` is reserved for a future event-bus API. Current React
integrations should use callback props.

## Appearance And Content

`appearance` uses token-based styling overrides. Undefined `appearance` keeps
the default QuickPay styling.

```tsx
<QuickPayEmbeddedCheckout
  source={{ type: 'checkout-session', checkoutId, checkoutType: 'direct' }}
  appearance={{
    backgroundPrimary: '#ffffff',
    textPrimary: '#111111',
    backgroundButton: '#111111',
  }}
/>
```

`content` can hide optional sections or override safe labels. It must not be
used to replace product names, prices, legal terms, or payment-status meaning.

## Security Checklist

- Keep merchant API credentials on the backend.
- Treat product and checkout-session amounts as server-authoritative.
- Treat browser callbacks as UX signals, not payment proof.
- Verify fulfillment through backend status or authenticated webhook.
- Keep Testnet3 and Mainnet origins, merchants, chains, and tokens separate.
- Pass `apiBase` or provide a same-origin reverse proxy for embedded hosts.
- Do not embed the Hosted Page itself in an iframe.
- Treat `checkoutId` as a bearer capability.

## Related Documents

- [Developer Quick Start](./goat-flow-developer-quickstart.md)
- [Hosted Checkout](./goat-flow-checkout.md)
- [API Reference](./goat-flow-api-reference.md)
- [Integration Guide](./goat-flow-integration.md)
- [GOAT Flow FAQ](./goat-flow-faq.md)
