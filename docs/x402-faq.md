# GOAT Flow FAQ

## Overview

This document summarizes common questions about GOAT Flow, including architecture, security, user experience, settlement, decentralization, wallet compatibility, and developer integration.

---

## Technical and Security

### General Architecture

#### What makes x402 different from existing payment solutions?

x402 brings the HTTP 402 **Payment Required** standard to Web3. Unlike payment widgets or checkout redirects, x402 works as a protocol layer that:

- returns a standard HTTP 402 response with payment details
- uses on-chain settlement with cryptographic proof
- supports programmable callbacks for atomic payment + action flows
- enables multi-chain support through a single integration

#### How does payment verification work?

Payments are verified on-chain through event monitoring:

1. The user transfers tokens to the designated `payTo` address in the x402 `accepts[]` entry.
2. A multi-chain listener monitors `Transfer` events.
3. The system matches the transfer to a pending order.
4. For DELEGATE orders, TSS-assisted callback / settlement execution is completed
   on the merchant's configured callback chain.
5. A payment proof is generated and cryptographically bound to the order.
6. Merchants can verify the proof through the API or directly on-chain.

#### What if a payment was sent but not detected?

The monitoring system is designed for high reliability:

- multiple RPC endpoints with automatic failover
- checkpointing to avoid skipping blocks
- order expiration leaves a 20-minute detection window
- if a payment is truly missed, contact support with the transaction hash

#### How are TSS keys managed?

The threshold signature scheme (TSS) is designed for enterprise-grade security:

- key shares are distributed across multiple independent nodes (`t-of-n` threshold)
- no single node can access the full private key
- signing requires collaboration from at least `t` nodes
- nodes are geographically distributed
- keys are rotated and audited regularly

---

## Security Model

#### How does x402 prevent replay attacks?

Replay protection uses multiple layers:

| Layer | Mechanism |
| --- | --- |
| API | HMAC timestamp validation (±5 minutes) + required one-time `X-Nonce` |
| Callback signature | EIP-712 `calldataNonce` per original payer |
| Contract storage | `calldataNonceUsed` mapping inside the MerchantCallback contract, exposed through `isCalldataNonceUsed` |

#### What prevents callback data from being tampered with?

EIP-712 typed-data signatures bind the callback to the full execution context.

The signature covers:

`token + owner + payer + amount + orderId(bytes32) + calldataNonce + deadline + keccak256(calldata)`

For Permit2 callback flows, the signature also covers `permit2`.

Any change to any field invalidates the signature.

#### How are chain reorganizations handled?

Payments require chain/token-specific confirmations before being finalized. The exact threshold is configured by the platform operator per chain and token; use the live chain configuration for production values.

Supported mainnet scope and mode availability:

| Chain | Chain ID | DIRECT | DELEGATE | Explorer |
| --- | --- | --- | --- | --- |
| Ethereum | `1` | Yes | Yes | `etherscan.io` |
| Polygon | `137` | Yes | Yes | `polygonscan.com` |
| BSC | `56` | Yes | Yes | `bscscan.com` |
| Arbitrum | `42161` | Yes | Yes | `arbiscan.io` |
| Optimism | `10` | Yes | Yes | `optimistic.etherscan.io` |
| Avalanche | `43114` | Yes | Yes | `snowtrace.io` |
| Base | `8453` | Yes | Yes | `basescan.org` |
| Berachain | `80094` | Yes | Yes | `berascan.com` |
| X Layer | `196` | Yes | Yes | `web3.okx.com/explorer/x-layer/evm` |
| GOAT | `2345` | Yes | Yes | `explorer.goat.network` |
| Metis | `1088` | Yes | No | `andromeda-explorer.metis.io` |
| Tempo | `4217` | Yes | No | `explore.tempo.xyz` |

The matrix describes merchant settlement/callback chains. DELEGATE requires an
approved EVM callback contract on that configured merchant chain; Metis and Tempo
use DIRECT as settlement modes. Eligible cross-chain source payments are derived
from live TSS/token configuration.

#### What if a TSS node is compromised?

Threshold signing provides resilience:

- a single compromised node cannot sign transactions
- an attacker would need the threshold minimum (for example, 3 out of 5)
- compromised nodes can be rotated without changing wallet addresses
- anomaly detection monitors suspicious signing patterns

---

## User Experience

### Getting Started

#### What does a user need in order to pay with x402?

A user needs:

1. A compatible wallet (MetaMask, Coinbase Wallet, WalletConnect-compatible wallets, etc.)
2. A supported token on a supported chain (such as USDC or USDT)
3. A small amount of native gas token, unless the flow uses a gasless mode

#### Which wallets are supported?

Any wallet that supports:

- standard ERC-20 token transfers
- EIP-712 typed-data signatures
- supported signature-based payment flows when applicable

Tested wallets include MetaMask, Coinbase Wallet, and Rainbow.

#### How long does one payment take?

Timing depends on the selected EVM chain, RPC health, and the confirmation threshold configured for that token. After the wallet broadcasts the transaction, low-latency L2/L1-style chains usually complete in seconds to tens of seconds, while Ethereum mainnet may take longer.

| Chain | Chain ID | Mode Availability |
| --- | --- | --- |
| Ethereum | `1` | DIRECT + DELEGATE |
| Polygon | `137` | DIRECT + DELEGATE |
| BSC | `56` | DIRECT + DELEGATE |
| Arbitrum | `42161` | DIRECT + DELEGATE |
| Optimism | `10` | DIRECT + DELEGATE |
| Avalanche | `43114` | DIRECT + DELEGATE |
| Base | `8453` | DIRECT + DELEGATE |
| Berachain | `80094` | DIRECT + DELEGATE |
| X Layer | `196` | DIRECT + DELEGATE |
| GOAT | `2345` | DIRECT + DELEGATE |
| Metis | `1088` | DIRECT |
| Tempo | `4217` | DIRECT |

#### Can users pay on mobile?

Yes. The SDK supports mobile wallet flows through:

- WalletConnect
- deep links into wallet apps
- embedded wallet SDKs

---

## Payment Flow

#### How many transactions does the user need to sign?

Usually one:

- **DIRECT mode**: a single ERC-20 transfer
- **DELEGATE mode with callback**: one signature that covers both payment and callback authorization

If the token flow requires an approval-style step, that may introduce an additional setup action depending on the integration path.

#### What if I do not hold tokens on the merchant's settlement chain?

- **DIRECT**: the payer must hold the selected token on the merchant's receiving
  chain and transfers directly to that chain's merchant address.
- **DELEGATE**: a Hosted Checkout decimal-price session may offer eligible
  source-chain/token choices even though the merchant callback/settlement chain is
  fixed. The hosted page shows only candidates derived from current merchant,
  token, and TSS configuration.

This is a controlled payment/settlement path, not a general-purpose bridge. If the
checkout does not list a chain/token you hold, move or acquire funds outside x402
before paying.

#### Can a payment be canceled after sending?

Once tokens are transferred on-chain, the transfer cannot be reversed. However:

- orders can be canceled before payment while still in `CHECKOUT_VERIFIED`
- nothing happens if an order expires without payment
- refunds depend on merchant policy

#### What if I pay the wrong amount?

The system matches exact amounts:

- **underpayment**: the order remains unpaid (and tokens may be lost if sent to the wrong address)
- **overpayment**: the excess stays at the destination address and is not automatically refunded
- best practice: use the SDK so the exact amount is handled automatically

---

## Fees and Settlement

### Pricing

#### How much does x402 charge merchants?

GOAT Flow uses a **fixed fee model charged per order**, not a percentage-based fee. Fees are configured by mode and chain. In general, **DIRECT mode carries a lower fixed fee**, while **DELEGATE mode carries a higher fixed fee** because it includes additional settlement, payout gas, and execution overhead. Merchant fees are deducted from a **pre-funded USD fee balance** when orders are created.

#### Who pays gas fees?

It depends on the mode:

- **User-paid**: standard ERC-20 transfer (user wallet → merchant)
- **Abstracted**: DELEGATE mode (user pays to the TSS address, and the TSS flow covers the payout gas)

In DELEGATE mode, gas costs are included in the service fee.

#### How do merchants pay fees?

Merchants maintain a USD-denominated fee balance:

1. top up through the dashboard or API
2. fees are deducted when orders are created
3. a successful order create returns the normal HTTP 402 x402 challenge
4. if the balance is too low, `POST /api/v1/orders` returns HTTP 400 with `{"error":"insufficient fee balance: available=$X, required=$Y"}`; QuickPay session creation returns HTTP 503
5. unused fees from expired orders are refunded

#### Which tokens are supported?

Currently supported:

- USDC
- USDT
- additional token support may be expanded over time based on product and merchant requirements

#### What about volatile assets like ETH or BTC?

The system is currently optimized for stablecoins such as USDC and USDT to support predictable pricing. Support for volatile assets is on the roadmap and would likely involve immediate conversion into stablecoins.

### Settlement

#### How quickly do merchants receive funds?

| Mode | Settlement Time |
| --- | --- |
| DIRECT | Immediate (same transfer flow) |
| DELEGATE | Within 1–2 blocks after payment confirmation |

#### Can merchants receive funds on a configured chain or token?

Merchants configure the chains, tokens, receiving assets, and callback chain they accept:

- **DIRECT**: user wallet -> merchant receiving address on the selected chain.
- **DELEGATE**: user payment on an eligible source chain -> TSS-assisted payout /
  callback -> merchant's single configured EVM settlement chain.

Cross-chain eligibility is runtime configuration, not an arbitrary bridge promise.

#### Is there a minimum payment amount?

There is no protocol-enforced minimum. In practice, the lower bound is around **$0.01**, because below that gas and operational costs may exceed the payment value.

#### How do merchants reconcile payments with accounting systems?

Available options include:

- webhook notifications for `order.invoiced`
- merchant order ID correlation
- API polling and reconciliation for other order states
- CSV export from the dashboard

---

## Decentralization

### Trust Model

#### How decentralized is x402?

x402 is a hybrid system optimized for practicality:

| Component | Centralization Level | Why |
| --- | --- | --- |
| API servers | Centralized | performance and user experience |
| Payment settlement | Decentralized | on-chain and trust-minimized |
| TSS signing | Distributed | multiple independent nodes |
| MerchantCallback | Decentralized | merchant-owned contract |

#### Does x402 custody user funds?

No.

Funds flow as follows:

1. **DIRECT mode**: user → merchant (x402 never touches the funds)
2. **DELEGATE mode**: user → TSS → merchant (TSS temporarily handles settlement, usually for less than one minute)

The system does not have unilateral access to user or merchant funds.

#### Can x402 freeze or censor payments?

Its intervention ability is limited:

- it cannot stop DIRECT-mode payments because those are direct user → merchant transfers
- in DELEGATE mode, TSS could theoretically delay payout, but funds are still destined for the merchant
- all transactions are auditable on-chain
- MerchantCallback contracts are owned and upgradeable by merchants

#### What happens if x402 stops operating?

Impact depends on the component:

- **DIRECT orders**: unaffected, because they are direct wallet transfers
- **in-flight DELEGATE orders**: TSS would still need to settle and distribute funds
- **MerchantCallback contracts**: continue to function because merchants own them
- **API / SDK layer**: may require migration or open-source alternatives in the future

#### Is the code open source?

The public `GOATNetwork/x402` repository is the external integration and
documentation surface. It contains the browser/server SDKs, Checkout and QuickPay
tooling, middleware, demo, callback contracts, and public documentation. Platform
core and operator applications are not presented as public modules in this
repository.

Production deployments are still operated environments, so confirm the deployed version, configuration, and TSS operator policy with the deployment operator.

---

## Wallet, AA, and Paymaster Integration

### Wallet Compatibility

#### Does x402 work with smart contract wallets (AA / ERC-4337)?

Yes. x402 is compatible with account abstraction:

- smart contract wallets can sign EIP-712 messages
- compatible with Safe, Argent, and other AA wallets
- no special integration is required

#### How does x402 compare with a Paymaster?

They are complementary, not competitive:

| Aspect | Paymaster | x402 |
| --- | --- | --- |
| Purpose | Gas abstraction | Payment protocol |
| Scope | Single transaction gas | Full payment lifecycle |
| Callback support | No | Yes (programmable) |
| Multi-chain | Per-chain setup | Unified flow |

A combined flow is also possible: users can pay for the service via x402 while gas is sponsored through a Paymaster.

#### Can x402 enable gasless transactions?

Yes, on DELEGATE-capable chains through two common paths:

1. **EIP-3009 tokens (such as USDC)**: `receiveWithAuthorization` supports gasless user flow
2. **Permit2**: users sign a permit and a relayer executes the transaction

In both cases, the user signs but does not directly pay gas.

#### Does x402 work with WalletConnect?

Yes. WalletConnect is fully supported:

- the SDK detects WalletConnect providers
- signature requests are forwarded to the connected mobile wallet
- the flow works across supported chains

### Account Abstraction Details

#### Can AA wallets execute x402 callback flows?

Yes.

#### What about session keys?

Session keys can be used together with x402:

- delegate signing authority to a session key
- let the session key sign x402 payment authorizations
- useful for subscriptions or automated payments
- spend limits remain enforced by the AA wallet

#### Does x402 support ERC-4337 UserOperations directly?

Not directly. x402 uses standard transactions, but it remains compatible:

- AA wallets can still execute standard ERC-20 transfers
- UserOperations can include x402 payments as internal calls
- bundler compatibility is preserved

---

## Integration and Development

### Getting Started

#### How do I get API credentials?

1. Submit a merchant application through the merchant portal or `POST /merchant/v1/auth/register` with `merchant_id`, `name`, `email`, `password`, and `receive_type`.
2. The application is created as pending and disabled; no API tokens are issued at registration time.
3. An admin/operator reviews the merchant in the admin dashboard or `/admin/merchants` and approves it by enabling the merchant, or rejects it through `/admin/merchants/:merchant_id/reject`.
4. After approval, the owner logs into the merchant portal and uses Developer / API Keys, or `POST /merchant/v1/api-keys/rotate`, to generate the API key and secret. Admins can also rotate merchant API keys through `/admin/merchants/:merchant_id/rotate-keys`.

#### Is there a testnet or sandbox?

The public docs are mainnet-first. Use the supported mainnet matrix above for production integration.

For sandbox testing, use the environment and chain IDs provided by the operator. Do not assume old public testnets are available.

#### What is the quickest path for an AI agent to pay?

Use QuickPay when the merchant has enabled it. Agents can discover the merchant's public payment surface without merchant API credentials:

- `GET /quickpay/:merchant_id/agent.md`
- `GET /quickpay/:merchant_id/manifest.json`
- `POST /quickpay/v1/x402/sessions`
- `GET /quickpay/v1/x402/sessions/:session_id`

The `goatflow-quickpay` CLI supports `inspect`,
`pay-x402 --amount --token-contract --chain`,
`pay-product --product --token-contract --chain`, and `pay-mpp --route`.

#### What is the fastest browser checkout integration?

Use `goatflow-checkout`. A QuickPay-enabled DIRECT merchant can open a fixed,
server-priced product with `open({ merchant, productKey })` and no merchant
backend. Dynamic DIRECT checkout and all DELEGATE checkout use the server SDK's
`createCheckoutSession(...)`, then pass the opaque `checkoutId` to
`open({ checkoutId })`.

The hosted page owns wallet connection, token selection, payment, and status UX.
The browser success callback is not payment proof; fulfill from
`quickpay.checkout.completed` or trusted backend status. See
[Hosted Checkout](x402-checkout.md).

#### How do I integrate x402 into an existing payment flow?

x402 is designed to fit into an existing checkout path as an additional payment method:

- existing flow: user → checkout → Stripe / PayPal → fulfillment
- x402 flow: user → checkout → x402 order → HTTP 402 response → user pays → fulfillment

---

## Troubleshooting

#### Why do I get HTTP 402 when creating an order?

HTTP 402 is the normal x402 `Payment Required` challenge for a successfully created order. The response contains the payment options in the body and in the `PAYMENT-REQUIRED` header.

Insufficient merchant fee balance is a different error. On `POST /api/v1/orders`, it returns HTTP 400:

```json
{
  "error": "insufficient fee balance: available=$0.050000, required=$0.200000"
}
```

On the QuickPay session path, the same condition is surfaced as HTTP 503 `merchant temporarily unavailable`. Top up the merchant fee balance only for those insufficient-balance errors, not for a normal 402 challenge.

#### The payment was sent, but the order is still `CHECKOUT_VERIFIED`. Why?

Possible reasons:

1. not enough confirmations yet
2. wrong amount sent
3. wrong token or wrong chain used
4. temporary listener delay (usually resolved within 1 minute)

If the issue persists, contact support with the transaction hash.

#### Callback execution failed. What happened?

Common causes include:

1. gas estimation failure because the callback reverts in simulation
2. invalid calldata encoding that does not match the target ABI
3. target contract state changed after the order was created
4. EIP-712 signature validation failed

Check the on-chain `CalldataExecuted(bytes calldata_, bool success, bytes result)` event. A failed callback is emitted with `success=false`, and `result` contains the returned error data.

---

## Compliance and Legal

#### Is x402 compliant with regulations?

x402 is infrastructure. Compliance depends on the merchant’s use case and jurisdiction:

- merchants are responsible for their own regulatory compliance
- x402 provides transaction records for audit purposes
- x402 does not collect user personal data by default
- it can integrate with compliance tooling such as Chainalysis

#### Do merchants need to run KYC on users?

That depends on the merchant’s jurisdiction and risk posture. x402 does not require KYC, but it does not prevent merchants from implementing it.

#### What about tax reporting?

The system provides:

- full transaction history through the API
- CSV export for accounting
- webhook events for real-time integration
- merchant-defined order IDs for reconciliation

Tax calculation and reporting remain the merchant’s responsibility.

---

## Contact and Support

For support related to x402 integrations, merchant setup, and partner ecosystem questions, please contact:

- **x402 support email:** `x402support@goat.network`
