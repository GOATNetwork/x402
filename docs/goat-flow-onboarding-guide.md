# GOAT Flow Onboarding Guide

This is the launch map for merchants, developers, and operations teams. Detailed
portal procedures and screenshots live in the
[Merchant Guide](./merchant-guide.md); technical implementation lives in the
[Developer Quick Start](./goat-flow-developer-quickstart.md) and
[Integration Guide](./goat-flow-integration.md).

The public GOAT Flow path is **DIRECT**: the buyer transfers the selected ERC-20
token directly to the merchant receiving address returned by the payment terms.

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
| **2. Configure receiving** | Add one valid receiving address for every accepted chain/token pair | [Merchant Guide §6](./merchant-guide.md#6-configure-receiving-addresses) |
| **3. Prepare access** | Configure QuickPay/Products and create backend API credentials only when required | [Merchant Guide §8](./merchant-guide.md#8-api-keys-management) and [§12](./merchant-guide.md#12-quickpay-and-products) |
| **4. Integrate** | Have a test buyer submit the first DIRECT transfer using the selected integration surface | [Developer Quick Start](./goat-flow-developer-quickstart.md) |
| **5. Test and launch** | Validate transfer verification, fulfillment, reconciliation, and operations in Testnet3 before production | [Integration Guide §13](./goat-flow-integration.md#13-production-checklist) |

## Completion Checks

| Step | Done when |
| --- | --- |
| Register | Merchant approved and enabled; owner can sign in |
| Configure receiving | Export or reviewed record of every enabled chain, token, and receiving address |
| Prepare access | QuickPay links/products are available, or the one-time API secret is stored server-side |
| Integrate | Application creates an order/session, presents runtime payment terms, and keeps merchant secrets out of the browser |
| Test and launch | Confirmed/invoiced test transfer, trusted fulfillment result, reconciliation record, and sufficient launch fee balance |

Keep completion records tied to their environment. Testnet3 screenshots and
transactions confirm testing only; they are not Mainnet configuration.

## Go-Live Checklist

**Environment**

- [ ] Production URLs, merchant ID, credentials, wallets, chain/token registry,
      webhooks, QuickPay/MPP configuration, and fee policy were verified from
      the live deployment.
- [ ] No Testnet3 credential, token contract, wallet, order ID, or callback URL
      is present in production configuration.

**Merchant**

- [ ] Merchant is approved and enabled.
- [ ] Receiving addresses are correct for every accepted chain/token pair.
- [ ] Merchant users reviewed password, 2FA, recovery, and role ownership.
- [ ] Fee balance covers expected launch traffic and top-up ownership is clear.

**Integration**

- [ ] Merchant API secrets remain backend-only.
- [ ] Pricing and payment terms are server/runtime-authoritative.
- [ ] Wallet chain, payer, recipient, amount, token, and expiry are validated.
- [ ] HTTP `402` challenge responses are handled as documented.
- [ ] Confirmed and failed/cancelled/expired states are handled.
- [ ] Status/proof or the verified GOAT Flow MPP-profile receipt gates fulfillment.
- [ ] Browser checkout callbacks do not unlock fulfillment by themselves.
- [ ] Webhook authentication and retry behavior are verified when webhooks are
      used.

**Operational Validation**

- [ ] A Testnet3 buyer transfer completed end to end.
- [ ] The transfer appears in Order Reconciliation with matching transaction,
      amount, token, chain, and status.
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
