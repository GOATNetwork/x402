# GOAT Flow Demo

This private workspace demo contains one default public path and several
advanced, config-gated examples.

## Modes

| UI path | Status | What it demonstrates |
| --- | --- | --- |
| Checkout SDK / DIRECT | Default public path | A merchant product opened in hosted checkout with `goatflow-checkout` |
| Advanced / Classic | Optional | Custom wallet UI, backend HMAC order creation, status polling, and calldata signing when returned by Core |
| Operator-provisioned checkout | Optional/internal | Compatibility session backed by `MerchantCallback` |
| Advanced / MPP | Optional | Browser flow for the GOAT Flow MPP adapter plus profile `Payment-Receipt` verification |

The DIRECT QuickPay merchant is configured by `VITE_QUICKPAY_MERCHANT`. It is
separate from the merchant represented by the backend `GOATX402_*` API key.

## Prerequisites

- Node.js 18 or newer
- pnpm
- the sibling packages in this repository
- a running hosted-checkout origin for DIRECT checkout

`pnpm dev` runs `predev`, which installs and builds the local TypeScript SDK,
server SDK, checkout SDK, and MPP middleware before starting the demo.

> **Current checkout caveat:** the package-local `pnpm-workspace.yaml` files
> contain build-policy settings but no `packages` field. pnpm `9.15.9` rejects
> `install`, `run`, and `exec` with `packages field missing or empty`. The
> workspace configuration must be corrected before the documented fresh-clone
> `pnpm install` / `pnpm dev` path is usable. Do not carry
> `--ignore-workspace` into release procedures because that also ignores the
> workspace policy file.

## Run The DIRECT Demo

```bash
cp .env.example .env
```

Set the public checkout values:

```dotenv
VITE_CHECKOUT_ORIGIN=http://localhost:3005
VITE_QUICKPAY_MERCHANT=test-merchant-1
VITE_QUICKPAY_PRODUCT=mug
```

`VITE_CHECKOUT_ORIGIN` defaults to `http://localhost:3005` when omitted. The
merchant/product pair must exist in that hosted-checkout environment. The
browser sends the merchant, product key, and a client reference; it does not
choose the authoritative price or payment amount.

Start the app:

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. The Express backend listens on
`http://localhost:3001` and Vite proxies `/api` to it.

Use `DEMO_WEB_PORT` to move the Vite port. The proxy target is currently fixed
to port `3001`, so changing `PORT` also requires updating `vite.config.ts`.

Hosted-checkout success callbacks are a browser UX signal. Fulfill orders from
an authenticated webhook or server-side status check.

## Advanced Classic Mode

Classic mode needs merchant API credentials on the Express backend:

```dotenv
GOATX402_MERCHANT_ID=your_merchant_id
GOATX402_API_URL=http://localhost:8286
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
```

The backend uses `goatflow-sdk-server` for HMAC-authenticated merchant and order
calls. The browser never receives the API secret. It fetches the merchant's
configured chains/tokens, connects an EVM wallet, creates an order through the
backend, and uses `PaymentHelper` from `goatflow-sdk` to submit the buyer-
authorized transfer returned by the order flow.

If Core returns a calldata-sign request, the browser signs it and submits the
signature through `POST /api/orders/:orderId/signature`.

## Operator-provisioned Checkout (Internal)

This section is hidden unless:

```dotenv
DELEGATE_ENABLED=1
# DELEGATE_SUCCESS_URL=https://your.app/success
# DELEGATE_CANCEL_URL=https://your.app/cancel
```

This source-only compatibility demo is outside public merchant onboarding. Its
API credentials must belong to a merchant whose callback contract has already
been deployed, authorized, and approved by the deployment operator.

The browser sends only `{ product_key }`. The demo backend owns the catalog and
USD price and creates:

```ts
createCheckoutSession({
  checkoutType: 'DELEGATE',
  price: product.priceUsd,
  // server-owned line items and metadata
})
```

Core derives the callback chain and available source-chain/token candidates
from merchant configuration. The bundled `mug` has no callback template. The
`tee` uses `MerchantCallback.testCallback(...)`, which is only a demo event
hook. Its template arguments are static demo values:
`MerchantCallback` neither replaces the template's `payer` argument with
`originalPayer` nor validates `payer` or `value` against the payment. See the
canonical
[`MerchantCallback` behavior](../goatx402-contract/MERCHANT_CALLBACK.md#calldata-execution-semantics)
and [hosted checkout guide](../docs/goat-flow-checkout.md).

## Optional MPP Mode

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol. This demo exercises GOAT Flow's current adapter and signed
receipt extension, not a generic MPP client/server exchange. The repository has
no interoperability test with official MPP SDKs.

The GOAT Flow MPP demo mode requires all four runtime values:

```dotenv
MPP_CORE_URL=http://localhost:8080
MPP_MERCHANT_ID=test-merchant-1
MPP_RECEIPT_KEY_HEX=<receipt verifier key>
MPP_RECEIPT_ALG=ed25519
```

Do not add a trailing slash to `MPP_CORE_URL`. For `ed25519`,
`MPP_RECEIPT_KEY_HEX` is the 32-byte public key, not the 64-byte private key.
For `hmac-sha256`, it is a shared secret of at least 32 bytes and is suitable
only for controlled single-tenant development.

The demo discovers active routes from:

```text
GET /merchants/:merchantId/mpp/routes
```

`MPP_ROUTE_OPTIONS` can override discovery with a JSON array. It is optional,
but every configured route must already exist in Core or the challenge request
will fail.

The browser calls Core directly for `/mpp/v1/challenge` and
`/mpp/v1/verify`. Core must allow the demo origin through
`mpp.cors.allowed_origins` or `MPP_API_ALLOWED_ORIGINS`, and expose the payment
response headers required by the SDK.

After verification, the browser sends the returned `Payment-Receipt` to:

```text
GET /api/mpp/protected/:optionId
```

The Express server loads `@goatnetwork/mpp-middleware` lazily and verifies that
receipt against the configured merchant, route, algorithm, and key. If MPP
configuration or middleware loading fails, `/api/mpp/config` returns `503` and
the UI disables payment.

## Build Checks

```bash
pnpm build
pnpm build:server
```

`pnpm build` validates the client TypeScript/Vite bundle.
`pnpm build:server` validates the Express server output used by `pnpm start`.
