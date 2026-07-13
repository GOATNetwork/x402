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
- enables EVM-chain support through a single integration

#### How does payment verification work?

Payments are verified on-chain through event monitoring:

1. In DIRECT, the user transfers tokens to the designated merchant `payToAddress`; in DELEGATE, the buyer SDK transfers ERC-20 tokens to a TSS `payToAddress`.
2. The EVM listener monitors transfer events and, when callback calldata is present, callback execution events.
3. The system matches the transfer event and optional callback authorization to a pending order.
4. The target-chain payment and optional callback are completed.
5. A payment proof is generated and cryptographically bound to the order.
6. Merchants can verify the proof through the API or directly on-chain.

#### What if a payment was sent but not detected?

The monitoring system is designed for high reliability:

- multiple RPC endpoints with automatic failover
- checkpointing to avoid skipping blocks
- order expiration leaves a 20-minute detection window
- if a payment is truly missed, contact support with the transaction hash

#### How is the platform Bob caller authorized?

DELEGATE callbacks are protected by the merchant-owned `MerchantCallback` contract:

- the platform operator/admin provides the current Bob caller address
- the merchant deploys `MerchantCallback`
- the merchant calls `setAuthorizedCaller(bob, true)`
- the merchant submits the callback contract in the Merchant Portal for admin review
- the callback contract rejects callers that are not authorized

---

## Security Model

#### How does x402 prevent replay attacks?

Replay protection uses multiple layers:

| Layer | Mechanism |
| --- | --- |
| API | Timestamp validation (±5 minutes) + required request nonce |
| On-chain | EIP-712 nonce per user address |
| Callback | `calldataNonces` mapping inside the MerchantCallback contract |

#### What prevents callback data from being tampered with?

EIP-712 typed-data signatures bind the callback to the full execution context.

The signature covers:

`token + owner + payer + amount + orderId + calldataNonce + deadline + keccak256(calldata)`

Any change to any field invalidates the signature.

#### How are chain reorganizations handled?

Payments require a configured minimum number of confirmations before being finalized. Confirmation thresholds are chain/token configuration, not a fixed docs table. Repository testnet examples include GOAT Testnet3 `48816`, BSC Testnet `97`, Sepolia `11155111`, and Tempo examples `4217` / `42431`.

Deep reorganizations beyond these thresholds are extremely rare and would require significant computational power.

#### What if the Bob caller needs to be rotated?

Bob caller changes are handled through the callback allowlist:

- the platform operator/admin provides the replacement Bob address
- the merchant authorizes the replacement with `setAuthorizedCaller(newBob, true)`
- the merchant removes the old caller if instructed by the platform
- callback execution fails closed if the caller is not authorized

---

## User Experience

### Getting Started

#### What does a user need in order to pay with x402?

A user needs:

1. A compatible wallet (MetaMask, Coinbase Wallet, WalletConnect-compatible wallets, etc.)
2. A supported token on a supported EVM chain (such as USDC or USDT)
3. A small amount of native gas token for standard transfer or approval paths, unless the selected flow uses gasless EIP-3009 signing

#### Which wallets are supported?

Any wallet that supports:

- standard ERC-20 token transfers
- EIP-712 typed-data signatures
- supported signature-based payment flows when applicable

Tested wallets include MetaMask, Coinbase Wallet, and Rainbow.

#### How long does one payment take?

Timing depends on the selected EVM chain, RPC health, and configured confirmation threshold. Treat timing numbers as environment-specific and read the active chain configuration instead of hardcoding a table.

#### Can users pay on mobile?

Yes. The SDK supports mobile wallet flows through:

- WalletConnect
- deep links into wallet apps
- embedded wallet SDKs

---

## Payment Flow

DIRECT and DELEGATE are mutually exclusive and fixed at merchant registration.

#### How many transactions does the user need to sign?

Usually one:

- **DIRECT mode**: usually a single ERC-20 transfer
- **DELEGATE mode**: the buyer completes the ERC-20 payment to the TSS `payToAddress`; if callback calldata is present, the buyer also signs a callback authorization that Bob submits to the approved `MerchantCallback`

If the token flow requires an approval-style step, that may introduce an additional setup action depending on the integration path.

#### What if I do not hold tokens on the merchant’s preferred chain?

x402 supports payment flows across supported EVM chains:

1. The merchant specifies accepted chains.
2. The user chooses which chain to pay from.
3. Payment and settlement behavior follow the merchant's configured chain/token support.

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

GOAT x402 uses a **fixed fee model charged per order**, not a percentage-based fee. Fees are configured by mode and chain. In general, **DIRECT mode carries a lower fixed fee**, while **DELEGATE mode carries a higher fixed fee** because it includes Bob-submitted callback execution overhead. Merchant fees are deducted from a **pre-funded USD Fee Balance** when orders are created.

#### Who pays gas fees?

It depends on the mode:

- **User-paid**: standard ERC-20 transfer (user wallet → merchant)
- **Abstracted callback gas**: in DELEGATE callback flows, platform Bob submits the callback transaction

DELEGATE payment still uses the order's ERC-20 payment flow to a TSS `payToAddress`. EIP-3009 can make the user payment gasless; approval-transfer flows may still require an approval transaction depending on token and wallet behavior. Bob-submitted callback gas costs are included in the service fee when callback execution is used.

#### How do merchants pay fees?

Merchants maintain a USD-denominated Fee Balance:

1. complete a Fee Top-up through the Fee Balance page or the operator-assisted process
2. fees are deducted when orders are created
3. if the balance is too low, programmatic order creation returns a business error such as HTTP `400`; QuickPay may return HTTP `503`
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
| DELEGATE | After the ERC-20 transfer to the TSS `payToAddress` confirms; callback completion depends on Bob submission if callback calldata is present |

#### Can merchants receive funds on a preferred chain or token?

Yes. Merchants can configure this in **Payment Setup → Receiving Tokens & Addresses**:

- EVM chain (for example, GOAT Network)
- receiving token (for example, USDC)
- receiving address

Supported EVM-chain routing depends on the merchant's current platform configuration.

#### Is there a minimum payment amount?

There is no global USD minimum in the protocol docs. Minimum amounts are configured per supported token and chain.

#### How do merchants reconcile payments with accounting systems?

Available options include:

- webhook notifications for `order.invoiced`
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
| Bob caller authorization | Merchant-controlled allowlist | only approved platform Bob callers can submit DELEGATE callbacks |
| MerchantCallback | Decentralized | merchant-owned contract |

#### Does x402 custody user funds?

It depends on the mode.

Funds flow as follows:

1. **DIRECT mode**: user → merchant (x402 never touches the funds)
2. **DELEGATE mode**: buyer ERC-20 payment → TSS `payToAddress`; optional callback authorization → platform Bob caller → merchant-approved `MerchantCallback`

The DELEGATE path uses the TSS `payToAddress` for payment collection and merchant-approved callback execution when callback calldata is present.

#### Can x402 freeze or censor payments?

Its intervention ability is limited:

- it cannot stop DIRECT-mode payments because those are direct user → merchant transfers
- in DELEGATE mode, Bob submission can be delayed, but Bob cannot call a callback unless the merchant authorized it
- all transactions are auditable on-chain
- MerchantCallback contracts are owned and upgradeable by merchants

#### What happens if x402 stops operating?

Impact depends on the component:

- **DIRECT orders**: unaffected, because they are direct wallet transfers
- **in-flight DELEGATE orders**: may require TSS payment processing, Bob submission, retry, or migration support from the operator
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
| EVM-chain support | Per-chain setup | Unified flow |

A combined flow is also possible: users can pay for the service via x402 while gas is sponsored through a Paymaster.

#### Can x402 enable gasless transactions?

Yes, through two common paths:

1. **EIP-3009 tokens (such as USDC)**: `receiveWithAuthorization` supports gasless user flow
2. **ERC20_APPROVE_XFER**: users may approve token spending and the platform executes the transfer path specified by the order

In EIP-3009 DELEGATE flows, the user signs but does not directly pay gas. Approval-transfer flows may still require an approval transaction depending on token and wallet behavior.

#### Does x402 work with WalletConnect?

Yes. WalletConnect is fully supported:

- the SDK detects WalletConnect providers
- signature requests are forwarded to the connected mobile wallet
- the flow works across supported EVM chains

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

Yes. Testnet support is environment-specific. Repository seed examples include:

- GOAT Testnet3 (Chain ID: `48816`)
- BSC Testnet (Chain ID: `97`)
- Sepolia (Chain ID: `11155111`)
- Tempo Moderato (Chain ID: `42431`) for Machine Payments Protocol (MPP) examples

Use testnet credentials for testing without real funds.

#### How do I integrate x402 into an existing payment flow?

x402 is designed to fit into an existing checkout path as an additional payment method:

- existing flow: user → checkout → Stripe / PayPal → fulfillment
- x402 flow: user → checkout → x402 order → HTTP 402 response → user pays → fulfillment

---

## Troubleshooting

#### Why do I get an insufficient Fee Balance error when creating an order?

For programmatic order creation, insufficient Fee Balance is a business error such as HTTP `400`. QuickPay may surface fee-balance unavailability as HTTP `503`. HTTP `402` is the successful x402 Payment Required response for a created order, not the insufficient-fee error.

Example:

```json
{
  "error": "Insufficient fee balance",
  "required": "0.20",
  "available": "0.05"
}
```

Complete a Fee Top-up for the merchant Fee Balance and retry.

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
- `order.invoiced` webhook events for real-time integration
- merchant-defined order IDs for reconciliation

Tax calculation and reporting remain the merchant’s responsibility.

---

## Contact and Support

For support related to x402 integrations, merchant setup, and partner ecosystem questions, please contact:

- **x402 support email:** `x402support@goat.network`
