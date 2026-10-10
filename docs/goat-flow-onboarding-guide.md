# GOAT Flow Onboarding Guide

This is the launch map for merchants, developers, and operations teams. Detailed
portal procedures and screenshots live in the
[Merchant Guide](./merchant-guide.md); technical implementation lives in the
[Developer Quick Start](./goat-flow-developer-quickstart.md) and
[Integration Guide](./goat-flow-integration.md).

GOAT Flow hosted checkout can offer Crypto and Card. In the Crypto **DIRECT**
path, the buyer transfers the selected ERC-20 token directly to the merchant
receiving address returned by the payment terms. In the Card path, an eligible
merchant offers a hosted page where the payer completes the provider flow.
Availability depends on the target deployment and merchant/product
configuration.

## Environment Separation

Treat Production and Testnet3 as separate deployments.

| Resource | Production | Testnet3 |
| --- | --- | --- |
| Merchant portal | `https://flow-merchant.goat.network` | `https://flow-merchant.testnet3.goat.network` |
| Admin portal (operators only) | `https://flow-admin.goat.network` | `https://flow-admin.testnet3.goat.network` |
| Flow API / standalone MPP Core | `https://flow-api.goat.network` | `https://flow-api.testnet3.goat.network` |
| QuickPay / checkout and same-origin public API | `https://flow-quickpay.goat.network` | `https://flow-quickpay.testnet3.goat.network` |

The QuickPay library derives its API paths from the trusted QuickPay link
origin. Use `flow-api` for authenticated merchant APIs and for standalone MPP
only when that Core origin is explicitly configured.

Keep separate merchant records, users, credentials, secret-manager entries,
receiving wallets, webhook endpoints/secrets, fee balances, products, MPP
routes, logs, alerts, and runbooks.

The npm package version does not select an environment. Keep the API and
Checkout origins, merchant account and credentials, products, and chain
configuration aligned. GOAT Testnet3 is `48816` (`eip155:48816`) and Mainnet is
`2345` (`eip155:2345`). Stripe test/live mode is independent of those chain
IDs and must be verified separately.

Do not derive production configuration from Testnet3 examples or screenshots.
Read chain IDs, token contracts, decimals, limits, fees, RPCs, explorers, and
enabled capabilities from the active environment. Order IDs, nonces,
idempotency keys, and wallet addresses are also environment-specific.

Before launch, create a reviewed production configuration record from the live
portal and API.

## Five-Step Path

| Step | Action | Detailed home |
| --- | --- | --- |
| **1. Register** | Create the merchant account and owner user; wait for approval | [Merchant Guide §3-4](./merchant-guide.md#3-register-a-merchant-account) |
| **2. Configure payment methods** | For Crypto, add a valid receiving address per chain/token; for Card, complete the merchant/Stripe enablement required by the deployment | [Merchant Guide §6](./merchant-guide.md#6-configure-receiving-addresses) |
| **3. Prepare access** | Configure QuickPay/Products and create backend API credentials only when required | [Merchant Guide §8](./merchant-guide.md#8-api-keys-management) and [§12](./merchant-guide.md#12-quickpay-and-products) |
| **4. Integrate** | Have a test buyer complete the chosen Crypto or Card flow using the selected integration surface | [Developer Quick Start](./goat-flow-developer-quickstart.md) |
| **5. Test and launch** | Validate rail-specific confirmation, fulfillment, reconciliation, and operations in the intended test mode before production | [Integration Guide §13](./goat-flow-integration.md#13-production-checklist) |

## Completion Checks

| Step | Done when |
| --- | --- |
| Register | Merchant approved and enabled; owner can sign in |
| Configure payment methods | Reviewed Crypto chain/token/recipient configuration and/or confirmed Card eligibility, currency, and provider mode |
| Prepare access | QuickPay links/products are available, or the one-time API secret is stored server-side |
| Integrate | Application creates an order/session, presents runtime payment terms, and keeps merchant secrets out of the browser |
| Test and launch | Completed rail-appropriate test payment, trusted fulfillment result, reconciliation record, and verified launch funding and fee requirements |

Keep completion records tied to their environment. Testnet3 screenshots and
transactions confirm testing only; they are not Mainnet configuration.

## Go-Live Checklist

**Environment**

- [ ] Production URLs, merchant ID, credentials, rail-appropriate wallet or
      provider configuration, webhooks, QuickPay/MPP configuration, and fee
      policy were verified from the live deployment.
- [ ] No Testnet3 credential, token contract, wallet, order ID, or callback URL
      is present in production configuration.

**Merchant**

- [ ] Merchant is approved and enabled.
- [ ] For Crypto, receiving addresses are correct for every accepted
      chain/token pair.
- [ ] Merchant users reviewed password, 2FA, recovery, and role ownership.
- [ ] Fee balance covers expected launch traffic and top-up ownership is clear.

**Integration**

- [ ] Merchant API secrets remain backend-only.
- [ ] Pricing and payment terms are server/runtime-authoritative.
- [ ] For Crypto, wallet chain, payer, recipient, amount, token, and expiry are validated.
- [ ] For Card, merchant eligibility, currency, provider test/live mode, and hosted completion flow are verified.
- [ ] HTTP `402` challenge responses are handled as documented.
- [ ] Confirmed and failed/cancelled/expired states are handled.
- [ ] Status/proof or the verified GOAT Flow MPP-profile receipt gates fulfillment.
- [ ] Browser checkout callbacks do not unlock fulfillment by themselves.
- [ ] Webhook authentication and retry behavior are verified when webhooks are
      used.

**Operational Validation**

- [ ] The chosen rail completed end to end in its intended test environment.
- [ ] The result appears in reconciliation with the rail-appropriate identity,
      amount, and status; Card confirmation is not required to have a chain
      transaction hash.
- [ ] Error messaging, retry limits, abandoned-order handling, monitoring,
      escalation, and support ownership were exercised.
- [ ] The production configuration and launch record were reviewed by
      merchant, engineering, and operations owners.

Related references:

- [API Reference](./goat-flow-api-reference.md)
- [Hosted Checkout](./goat-flow-checkout.md)
- [GOAT Flow MPP Integration](./mpp.md)
- [DApp Integration Skill](./goat-flow-dapp-integration/SKILL.md)
- [GOAT Flow FAQ](./goat-flow-faq.md)

Support: [Support@goat.network](mailto:Support@goat.network)
