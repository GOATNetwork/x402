# GOAT Flow Docs

This is the public documentation hub for **GOAT Flow**, the GOAT Network
commerce and transfer-verification software for merchants, applications, and
agents using the x402 protocol.

GOAT Flow provides four related integration surfaces:

- authenticated x402 order creation and status/proof APIs
- hosted checkout for server-created sessions and QuickPay products
- public QuickPay discovery and payer-transfer tooling
- GOAT Flow's current integration profile for the open Machine Payments
  Protocol (MPP), including challenges, receipts, and merchant middleware

GOAT Flow hosted checkout supports crypto and card payments when the target
deployment and merchant or product configuration enable them. The ERC-20
steps in these guides describe the crypto **DIRECT** path: the buyer transfers
the selected token to the merchant receiving address. Card payment is completed
by the payer on the hosted page. `checkoutType: 'DIRECT'` selects the checkout
subsystem; `paymentRails: ['crypto']`, `['fiat']`, or both selects the payment
methods offered by that session, so a card session can also be `DIRECT`.

[MPP](https://mpp.dev/overview) is an independent open protocol, not a GOAT Flow
protocol. The current MPP client and middleware implement a GOAT-specific
JSON-endpoint and signed-receipt profile; they are not official MPP SDKs and do
not establish generic MPP interoperability.

For the Crypto flow, GOAT Flow observes and verifies the on-chain transfer;
customer funds do not pass through GOAT Flow. Card confirmation follows the
target deployment's hosted provider and server-status/webhook contract.

---

## Service Origins

| Surface | Testnet3 origin | Mainnet origin | Audience |
| --- | --- | --- | --- |
| GOAT Flow product website | — | `https://www.goat.network/flow` | Product information only; not an SDK or checkout origin |
| Merchant Portal | `https://flow-merchant.testnet3.goat.network` | `https://flow-merchant.goat.network` | Merchants and merchant team members |
| Admin Portal | `https://flow-admin.testnet3.goat.network` | `https://flow-admin.goat.network` | Authorized GOAT Flow operators only |
| QuickPay / Hosted Checkout and same-origin public API | `https://flow-quickpay.testnet3.goat.network` | `https://flow-quickpay.goat.network` | Buyers, agents, and checkout integrations |
| Flow API / standalone MPP Core | `https://flow-api.testnet3.goat.network` | `https://flow-api.goat.network` | Authenticated server and explicitly configured standalone MPP integrations |

| GOAT network value | Testnet3 | Mainnet |
| --- | --- | --- |
| Chain ID | `48816` | `2345` |
| x402 network identifier | `eip155:48816` | `eip155:2345` |

The product website is not a valid server-SDK `baseUrl` or Checkout `origin`.
Do not reuse Mainnet credentials, merchant IDs, products, receiving
configuration, or Checkout sessions in Testnet3. The Admin Portal is not a
merchant or public API integration surface.

The QuickPay client derives session and MPP paths from the trusted
`flow-quickpay` link origin and ignores absolute endpoint substitution from a
manifest. `flow-api` is the configured merchant API and standalone MPP Core
origin; do not silently swap these origins in client code even when a deployment
currently proxies equivalent routes.

---

## npm Packages

As verified on October 9, 2026, the package versions below are published on
npm and carry the `latest` dist-tag. These examples target those versions. Use
a lockfile to keep an application's dependency versions stable; existing
applications do not need to upgrade merely because this documentation was
corrected. The [release procedure](../RELEASING.md) governs future releases.
All four packages declare Node.js 18 or later where Node is used.

| Package | Published version | Primary use | Exact install |
| --- | ---: | --- | --- |
| [`goatflow-sdk`](../goatx402-sdk/README.md) | [0.3.0](../goatx402-sdk/CHANGELOG.md) | Browser wallet transfers and the GOAT Flow MPP adapter | `npm install goatflow-sdk@0.3.0` |
| [`goatflow-sdk-server`](../goatx402-sdk-server-ts/README.md) | [0.4.0](../goatx402-sdk-server-ts/CHANGELOG.md) | TypeScript merchant backend and HMAC-authenticated APIs | `npm install goatflow-sdk-server@0.4.0` |
| [`goatflow-checkout`](../goatx402-checkout/README.md) | [0.2.0](../goatx402-checkout/CHANGELOG.md) | Hosted Checkout browser integration | `npm install goatflow-checkout@0.2.0` |
| [`goatflow-paykit`](../goatx402-quickpay/README.md) | [0.4.0](../goatx402-quickpay/CHANGELOG.md) | PayKit payer/agent library and CLI | `npm install goatflow-paykit@0.4.0` |

### Migration from QuickPay

Replace the `goatflow-quickpay` dependency and import specifiers with
`goatflow-paykit`. The class name `QuickPayClient` remains available. Use
`npx goatflow-paykit`; the new package also installs a `goatflow-quickpay`
executable alias, but `npx goatflow-quickpay` without that local installation
still resolves the old npm package, not PayKit.

Prefer `PAYKIT_PRIVATE_KEY` and `PAYKIT_RPC[_<chainId>]`; the corresponding
`QUICKPAY_*` environment variables remain supported. Public merchant links
accept `/paykit/{merchant_id}` and legacy `/quickpay/{merchant_id}`, with the
same optional `/agent.md` or `/manifest.json` suffix. The client continues to
derive API endpoints under `/quickpay/v1` on the trusted origin. Repository
directory names remain `goatx402-*`.

The TypeScript MPP middleware package name
`@goatnetwork/mpp-middleware`, the Go modules, contracts, and demo are not
public npm packages. Follow their package README files for source-based use;
do not infer Registry availability from a local `package.json`.

---

## Start Here

1. [What is GOAT Flow](./what-is-goat-flow.md) explains the product, protocol, and
   current payment surfaces.
2. [Why GOAT Flow](./why-goat-flow.md) explains the implementation-backed product
   value and tradeoffs.
3. [GOAT Flow FAQ](./goat-flow-faq.md) answers common questions about payments, runtime
   configuration, QuickPay, MPP, errors, and security boundaries.

---

## Developer Path

1. [Developer Quick Start](./goat-flow-developer-quickstart.md)
2. [API Reference](./goat-flow-api-reference.md)
3. [Hosted Checkout](./goat-flow-checkout.md)
4. [Integration Guide](./goat-flow-integration.md)
5. [GOAT Flow MPP Integration](./mpp.md)
6. [DApp Integration Skill](./goat-flow-dapp-integration/SKILL.md)

The root-level [`API.md`](../API.md) and
[`DEVELOPER_FAST.md`](../DEVELOPER_FAST.md) files redirect historical links to
the maintained documents above.

Package references:

- [Browser payment SDK](../goatx402-sdk/README.md)
- [Server SDK](../goatx402-sdk-server-ts/README.md)
- [Go Server SDK](../goatx402-sdk-server-go/README.md)
- [Hosted Checkout SDK](../goatx402-checkout/README.md)
- [PayKit library and CLI](../goatx402-quickpay/README.md)
- [TypeScript MPP middleware](../goatx402-mpp-middleware-ts/README.md)
- [Go MPP middleware](../goatx402-mpp-middleware-go/README.md)

---

## Merchant and Operations Path

1. [Onboarding Guide](./goat-flow-onboarding-guide.md)
2. [Merchant Guide](./merchant-guide.md)
3. [GOAT Flow FAQ](./goat-flow-faq.md)

Merchant registration, approval, account recovery, 2FA, API-key rotation, fee
configuration, and portal permissions are deployment-operated concerns. Follow
the deployed portal and the merchant-facing guides for those procedures; the
public SDK types do not define their complete policy.

---

## Choose an Integration Surface

| Need | Recommended surface | Important boundary |
| --- | --- | --- |
| Create and track a backend payment | Server SDK order API | HTTP 402 is the expected create-order challenge |
| Fixed-price item with configured Crypto and/or Card | QuickPay Product + Checkout SDK | Product price and available payment methods are server-authoritative |
| Dynamic or server-priced purchase | Hosted Checkout Session | Backend creates the amount and terms |
| Eligible Card purchase | Hosted Checkout Product or Session | Payer completes the hosted page; creation/callback is not confirmation |
| Custom amount, tip, or donation | QuickPay custom-amount flow | Browser-supplied amount is untrusted for fulfillment |
| Agent payment for a protected API route | Current GOAT Flow MPP profile | Success requires the profile's signed `Payment-Receipt` |

---

## Runtime Configuration

Do not hardcode a global chain, token, minimum, or maximum list from narrative
documentation.

- Authenticated integrations receive payment terms from the x402 challenge.
- Public QuickPay integrations discover token limits, products, and MPP routes
  from the merchant manifest.
- The server SDK's public merchant lookup exposes the merchant's configured
  receive type and token entries.

The npm package version does not select Testnet3 or Mainnet. API and checkout
origins, merchant credentials, merchant/product configuration, and chain
settings must all belong to the same deployment. For GOAT Network itself,
Testnet3 is chain `48816` (`eip155:48816`) and Mainnet is chain `2345`
(`eip155:2345`); other EVM chains and tokens remain runtime-defined. Stripe
test/live mode is separate from chain selection and must be confirmed for the
target deployment before testing card payments.

Fees, registration approval, account-security policy, and webhook event names
vary by environment. Confirm them with the active portal and API.

---

## Fulfillment Rule

Checkout browser callbacks are UX signals, not payment proof. Fulfill only after
a trusted backend status check or an authenticated webhook whose event name,
signature rules, and payload have been confirmed for the deployment.

In the current GOAT Flow MPP profile, the protected resource validates the
profile's signed `Payment-Receipt` with the supplied middleware before
continuing to the handler.

---

## Document Index

| Document | Primary audience | Purpose |
| --- | --- | --- |
| [What is GOAT Flow](./what-is-goat-flow.md) | Everyone | Product and protocol overview |
| [Why GOAT Flow](./why-goat-flow.md) | Product, business, developers | Product value and tradeoffs |
| [GOAT Flow FAQ](./goat-flow-faq.md) | Everyone | Payments, configuration, errors, and security |
| [Onboarding Guide](./goat-flow-onboarding-guide.md) | Merchants, operations | Portal onboarding and go-live workflow |
| [Merchant Guide](./merchant-guide.md) | Merchants, support | Portal configuration and operations |
| [Developer Quick Start](./goat-flow-developer-quickstart.md) | Developers | First integration |
| [API Reference](./goat-flow-api-reference.md) | Developers | API contract |
| [Hosted Checkout](./goat-flow-checkout.md) | Frontend and backend developers | Product and session checkout |
| [Integration Guide](./goat-flow-integration.md) | Developers, technical PMs | Detailed architecture and SDK usage |
| [GOAT Flow MPP Integration](./mpp.md) | Agent and API developers | Protocol boundary plus GOAT-specific challenge, transfer, receipt, and middleware |
| [DApp Integration Skill](./goat-flow-dapp-integration/SKILL.md) | Coding agents | Integration workflow, deliverables, and acceptance criteria |

Support: [Support@goat.network](mailto:Support@goat.network)
