# goatflow-paykit

Public payer/agent library and CLI for **GOAT Flow PayKit**. It is generic,
stateless, and manifest-driven: it does not know any specific merchant — the
merchant identity comes entirely from the link a merchant shares.

For Crypto and the current GOAT Flow MPP profile, the library coordinates a
buyer-wallet transfer directly to the instructed merchant recipient and
verifies the resulting session or receipt. For Card, it creates a hosted link
that a human payer must complete; link creation is not payment confirmation.
The library does not interact with merchant customer funds as an intermediary
and never accepts card credentials.

[Machine Payments Protocol (MPP)](https://mpp.dev/overview) is an independent
open protocol. QuickPay's `pay-mpp` command uses GOAT Flow's current MPP adapter,
whose JSON challenge/verify endpoints and signed three-segment receipt are
GOAT-specific. It is not a generic MPP transport, and this repository contains
no interoperability test with official MPP SDKs.

## Migration from QuickPay

Install `goatflow-paykit` in place of `goatflow-quickpay`. The public
`QuickPayClient` API remains available, and the installed package provides both
`goatflow-paykit` and `goatflow-quickpay` executable names. Prefer
`PAYKIT_PRIVATE_KEY` / `PAYKIT_RPC[_<chainId>]`; the `QUICKPAY_*` environment
variables remain supported. Existing `/quickpay/` links remain accepted.

## Install

```bash
npm install goatflow-paykit@0.4.0

# Required only for the built-in pay-mpp backend:
npm install goatflow-sdk@0.3.0
```

The examples below use the Mainnet PayKit origin and placeholder merchant,
token, and chain values. Read actual capabilities from `inspect` / the manifest.
For Testnet3, switch the origin to
`https://flow-quickpay.testnet3.goat.network` and use configuration from that
deployment; the npm version does not choose an environment.

```bash
# show available commands
npx goatflow-paykit --help

# inspect a merchant's payment capabilities (machine-readable JSON)
npx goatflow-paykit inspect https://flow-quickpay.goat.network/paykit/acme/agent.md --json

# Provide the payer key WITHOUT writing the secret into a command (shell history and
# agent transcripts leak it): set PAYKIT_PRIVATE_KEY in your environment out-of-band
# (e.g. from a secret manager), or pass --wallet-file <path> (a chmod 600 key file).

# pay a custom amount via x402
npx goatflow-paykit pay-x402 https://flow-quickpay.goat.network/paykit/acme/agent.md \
  --amount 12.50 --token-contract 0xToken --chain 4217

# buy a fixed-price product (the merchant prices it; you only pick the token + chain)
npx goatflow-paykit pay-product https://flow-quickpay.goat.network/paykit/acme/agent.md \
  --product mug --token-contract 0xToken --chain 4217

# pay a fixed MPP route
npx goatflow-paykit pay-mpp https://flow-quickpay.goat.network/paykit/acme/agent.md \
  --route GET:api:data
```

`inspect` lists Crypto products under `x402_products` and Card products under
`fiat_products`; it also reports Card currency, minor-unit exponent, and
`fiat_human_action_required`. A Crypto product carries a **token-agnostic**
decimal price; the buyer picks the token, and `pay-product` re-denominates the
price in that token and **refuses to broadcast unless the session's quoted
amount matches**. This prevents the client from submitting a transfer above the
manifest-advertised price.

Library usage:

```ts
import { QuickPayClient } from 'goatflow-paykit'

const client = new QuickPayClient('https://flow-quickpay.goat.network/paykit/acme/agent.md')
const manifest = await client.loadManifest()
const summary = await client.inspect()
```

Library options are camelCase, not raw API JSON. `payX402()` accepts `amount`,
`chainId`, `tokenSymbol`/`tokenContract`, `memo`, and `idempotencyKey`;
`payProduct()` accepts `productKey`, chain/token selection, and optional
`idempotencyKey`. The client derives wire `merchant_id` from the trusted URL and
`payer_addr` from the payment backend. It does not currently expose a
`clientReferenceId` option.

The corresponding custom-amount wire request is:

```json
{
  "merchant_id": "acme",
  "payer_addr": "0xBuyer",
  "chain_id": 4217,
  "token_contract": "0xToken",
  "amount_wei": "12500000",
  "memo": "invoice-123",
  "idempotency_key": "invoice-123:buyer"
}
```

## Hosted card checkout

Use `createFiatCheckoutLink()` or the CLI command below to create a link for a
human payer. The library never accepts card credentials. The hosted URL must
remain on the trusted origin. The requested custom amount is validated against
the manifest's currency precision, and the response currency, checkout ID,
expiry, and hosted URL are validated. The response does not contain an amount;
for a Product, the server remains authoritative for its pinned price.

```bash
npx goatflow-paykit create-card-checkout https://flow-quickpay.goat.network/paykit/acme/agent.md \
  --product mug

# Or create a custom-amount Card link when the manifest enables it:
npx goatflow-paykit create-card-checkout https://flow-quickpay.goat.network/paykit/acme/agent.md \
  --amount 10.00 --memo donation
```

```ts
const cardLink = await client.createFiatCheckoutLink({ productKey: 'mug' })
// Redirect a human payer to cardLink.url; do not mark the purchase paid here.
```

The result has `human_action_required: true`: link creation is not payment
confirmation. The payer must enter card details and complete the hosted flow.

## Security model — the host is the trust anchor

The input link's **origin** (`scheme://host`) is the single trust anchor:

- The `merchant_id` is taken from the trusted URL **path**, and the fetched
  `manifest.json` must self-identify as the same merchant or the command **fails
  closed**.
- Every endpoint the CLI calls (session create/status, MPP challenge/verify) is
  **derived from the origin**. Absolute URLs embedded in the manifest are never
  trusted, so a tampered manifest cannot redirect the buyer's transfer
  instruction to another host.
- The origin must be **`https://`** (plaintext `http://` is rejected except for
  loopback hosts in local dev), because an on-path attacker on plaintext could
  swap the session's `payTo` and redirect funds.

Share only links on a host you trust (e.g. `flow-quickpay.goat.network`).

This same-origin rule is specific to QuickPay-driven MPP. A standalone
`goatflow-sdk` `MPPClient` instead uses the deployment's configured Core/API
`coreUrl`.

Manifest validation is a discovery/preflight boundary, not the final transfer
instruction. Non-array token or route lists are normalized to empty lists,
`payX402()` rejects an explicitly disabled `custom_amount` flag for new
sessions, and Product limits remain server-authoritative. An explicit
idempotency key can resume an existing payment after a merchant disables a rail. The returned session or MPP challenge
provides the current transfer terms.

## Retry safety (avoid double-paying)

QuickPay session terminal states are `PAYMENT_CONFIRMED`, `EXPIRED`, `FAILED`,
and `CANCELLED`. This is separate from the Server SDK order model, where
`INVOICED` is also a successful terminal state.

- A **reused** session (same payment intent) is **not auto-paid** — the CLI
  resumes/polls it. Only pass `--force` to `pay-x402`/`pay-product` to broadcast on
  a reused session, and only when you are certain no payment was sent (e.g. the
  wallet rejected the first attempt).
- Polling uses `pollTimeoutMs` as a hard overall cap: sleeps and individual
  status requests are bounded by the remaining time.
- A broadcast transaction hash is retained across status-fetch failures. For a
  fresh payment, a server-confirmed fee-bump replacement can become the final
  hash; a forced reused session does not replace its local hash with an
  unrelated prior server value.
- If a known transaction is reported `EXPIRED`, the client performs five
  bounded grace polls because a pre-expiry transfer can confirm late.
- If MPP fails after broadcast, preserve the reported transaction hash and
  challenge context. Reconcile by `session_id` and `tx_hash`; never rebroadcast
  merely because status polling or receipt verification failed.

## Configuration

- Wallet key precedence (highest first): `--wallet-file <path>` (a file holding
  the key; `chmod 600` it), `--wallet <privateKey>`, `PAYKIT_PRIVATE_KEY`, then
  legacy `QUICKPAY_PRIVATE_KEY`. Environment lookup uses the first non-empty
  value. A raw key in argv (`--wallet`) leaks via `ps`, shell history, CI logs,
  and agent transcripts, so it warns — prefer `PAYKIT_PRIVATE_KEY` or
  `--wallet-file`.
- Token: prefer `--token-contract <address>` from the manifest. `--token <SYM>`
  is accepted only when the symbol is unique on that chain.
- RPC URL precedence (highest first): `PAYKIT_RPC_<chainId>`, legacy
  `QUICKPAY_RPC_<chainId>`, `--rpc <url>`, `PAYKIT_RPC`, then legacy
  `QUICKPAY_RPC`. Environment lookup uses the first non-empty value. A
  per-chain environment variable intentionally overrides the explicit flag.

## Architecture

- `client.ts` — library-first `QuickPayClient` facade.
- `manifest.ts` — link resolution, schema validation, trust-anchor enforcement.
- `inspect.ts` / `pay.ts` — capability discovery and the x402 / MPP orchestration.
  The on-chain step is behind an injectable backend so the orchestration is unit
  tested without a chain.
- `backend-ethers.ts` — real ERC20 transfer for `pay-x402` (ethers v6).
- `backend-mpp-sdk.ts` — `pay-mpp` delegates to `goatflow-sdk`'s `MPPClient`
  (an **optional** dependency loaded at runtime).

> The live on-chain flows (the ERC-20 transfer and MPP transfer/receipt
> verification) require a chain + wallet and are not exercised by the unit tests;
> the manifest handling, trust-anchor enforcement, and request orchestration are.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run test:run    # vitest
npm run build       # emit dist/
```

See the [QuickPay integration guide](../docs/goat-flow-integration.md#8-quickpay),
[GOAT Flow MPP integration profile](../docs/mpp.md), and
[Changelog](./CHANGELOG.md).
