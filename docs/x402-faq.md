# GOAT Network x402 FAQ

## Overview

This document summarizes common questions about GOAT Network x402, including architecture, security, user experience, settlement, decentralization, wallet compatibility, and developer integration.

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

1. The user transfers tokens to the designated `payToAddress`.
2. A multi-chain listener monitors `Transfer` events.
3. The system matches the transfer to a pending order.
4. The target-chain payment and callback are completed.
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
| API | Timestamp validation (±5 minutes) + idempotency key |
| On-chain | EIP-712 nonce per user address |
| Callback | `calldataNonces` mapping inside the MerchantCallback contract |

#### What prevents callback data from being tampered with?

EIP-712 typed-data signatures bind the callback to the full execution context.

The signature covers:

`token + owner + payer + amount + orderId + nonce + deadline + keccak256(calldata)`

Any change to any field invalidates the signature.

#### How are chain reorganizations handled?

Payments require a minimum number of confirmations before being finalized:

- GOAT Network: 2 blocks (~7 seconds)
- Ethereum: 12 blocks (~3 minutes)
- Polygon: 128 blocks (~4 minutes)
- Arbitrum: 1 block (L2 finality derived from L1)
- BSC: 15 blocks (~45 seconds)

Deep reorganizations beyond these thresholds are extremely rare and would require significant computational power.

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

Timing depends on the chain and required confirmations. Reference timing after the transaction is broadcast:

| Chain | User Action | Detection | Final Confirmation |
| --- | --- | --- | --- |
| GOAT Network | ~3s | 2–5s | ~10s |
| Polygon | ~3s | 5–15s | ~20s |
| Arbitrum | ~3s | 2–5s | ~10s |
| BSC | ~3s | 15–30s | ~35s |
| Ethereum | ~3s | 30–60s | ~1 min |
| Solana | ~2s | 5–10s | ~15s |

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

#### What if I do not hold tokens on the merchant’s preferred chain?

x402 supports cross-chain payment flows:

1. The merchant specifies accepted chains.
2. The user chooses which chain to pay from.
3. Settlement completes automatically to the merchant’s preferred chain.

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

GOAT x402 uses a **fixed fee model charged per order**, not a percentage-based fee. Fees are configured by mode and chain. In general, **DIRECT mode carries a lower fixed fee**, while **DELEGATE mode carries a higher fixed fee** because it includes additional settlement, payout gas, and execution overhead. Merchant fees are deducted from a **pre-funded USD fee balance** when orders are created.

#### Who pays gas fees?

It depends on the mode:

- **User-paid**: standard ERC-20 transfer (user wallet → merchant)
- **Abstracted**: DELEGATE mode (user pays to the TSS address, and the TSS flow covers the payout gas)

In DELEGATE mode, gas costs are included in the service fee.

#### How do merchants pay fees?

Merchants maintain a USD-denominated fee balance:

1. top up through the dashboard or API
2. fees are deducted when orders are created
3. if the balance is too low, the API returns HTTP 402
4. unused fees from expired orders are refunded

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

#### Can merchants receive funds on a preferred chain or token?

Yes. Merchants can configure:

- settlement chain (for example, GOAT Network)
- settlement token (for example, USDC)
- settlement address

Cross-chain settlement is handled automatically.

#### Is there a minimum payment amount?

There is no protocol-enforced minimum. In practice, the lower bound is around **$0.01**, because below that gas and operational costs may exceed the payment value.

#### How do merchants reconcile payments with accounting systems?

Available options include:

- webhook notifications for every status change
- merchant order ID correlation
- API polling for order status
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

Partially:

- MerchantCallback contracts: open source and auditable
- SDKs: open source and inspectable
- core infrastructure: not fully open source yet, but planned on the roadmap

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

Yes, through two common paths:

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

1. Register in the GOAT Network developer center.
2. Complete verification.
3. Create an app.
4. Obtain your API key and secret.

#### Is there a testnet or sandbox?

Yes. Testnet support includes:

- GOAT testnet (Chain ID: 2345)
- Polygon Mumbai
- Arbitrum Sepolia

Use testnet credentials for testing without real funds.

#### How do I integrate x402 into an existing payment flow?

x402 is designed to fit into an existing checkout path as an additional payment method:

- existing flow: user → checkout → Stripe / PayPal → fulfillment
- x402 flow: user → checkout → x402 order → HTTP 402 response → user pays → fulfillment

---

## Troubleshooting

#### Why do I get HTTP 402 when creating an order?

In this context, the API returns HTTP 402 when the merchant fee balance is insufficient.

Example:

```json
{
  "error": "Insufficient fee balance",
  "required": "0.20",
  "available": "0.05"
}
```

Top up the merchant fee balance and retry.

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

Check the on-chain `CalldataFailed` event for the revert reason.

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
