# goatflow-quickpay

Public payer/agent library and CLI for **GOAT Flow QuickPay**. It is generic,
stateless, and manifest-driven: it does not know any specific merchant — the
merchant identity comes entirely from the link a merchant shares.

```bash
# show available commands
npx goatflow-quickpay --help

# inspect a merchant's payment capabilities (machine-readable JSON)
npx goatflow-quickpay inspect https://pay.goat.network/quickpay/acme/agent.md --json

# Provide the payer key WITHOUT writing the secret into a command (shell history and
# agent transcripts leak it): set QUICKPAY_PRIVATE_KEY in your environment out-of-band
# (e.g. from a secret manager), or pass --wallet-file <path> (a chmod 600 key file).

# pay a custom amount via x402
npx goatflow-quickpay pay-x402 https://pay.goat.network/quickpay/acme/agent.md \
  --amount 12.50 --token-contract 0xToken --chain 4217

# buy a fixed-price product (the merchant prices it; you only pick the token + chain)
npx goatflow-quickpay pay-product https://pay.goat.network/quickpay/acme/agent.md \
  --product mug --token-contract 0xToken --chain 4217

# pay a fixed MPP route
npx goatflow-quickpay pay-mpp https://pay.goat.network/quickpay/acme/agent.md \
  --route GET:api:data
```

`inspect` lists the merchant's products (`product_key`, `name`, `price`) under
`x402_products`. A product carries a **token-agnostic** decimal price; the buyer
picks the token, and `pay-product` re-denominates the price in that token and
**refuses to broadcast unless the session's quoted amount matches** — so the
server can never charge more than the manifest-advertised price.

Library usage:

```ts
import { QuickPayClient } from 'goatflow-quickpay'

const client = new QuickPayClient('https://pay.goat.network/quickpay/acme/agent.md')
const manifest = await client.loadManifest()
const summary = await client.inspect()
```

## Security model — the host is the trust anchor

The input link's **origin** (`scheme://host`) is the single trust anchor:

- The `merchant_id` is taken from the trusted URL **path**, and the fetched
  `manifest.json` must self-identify as the same merchant or the command **fails
  closed**.
- Every endpoint the CLI calls (session create/status, MPP challenge/verify) is
  **derived from the origin**. Absolute URLs embedded in the manifest are never
  trusted, so a tampered manifest cannot redirect a payment to another host.
- The origin must be **`https://`** (plaintext `http://` is rejected except for
  loopback hosts in local dev), because an on-path attacker on plaintext could
  swap the session's `payTo` and redirect funds.

Share only links on a host you trust (e.g. `pay.goat.network`).

## Retry safety (avoid double-paying)

`pay-x402`, `pay-product`, and `pay-mpp` are designed so a retry never silently pays twice:

- The broadcast `tx_hash` is always returned (even if confirmation polling fails),
  so you can resume by polling rather than re-sending.
- A **reused** session (same payment intent) is **not auto-paid** — the CLI
  resumes/polls it. Only pass `--force` to `pay-x402`/`pay-product` to broadcast on
  a reused session, and only when you are certain no payment was sent (e.g. the
  wallet rejected the first attempt).
- If `pay-mpp` fails after broadcasting, the JSON output preserves the `tx_hash`
  and `challenge` so you can resume verification instead of paying again.

## Configuration

- Wallet key (in precedence order): `--wallet-file <path>` (a file holding the key;
  `chmod 600` it), `--wallet <privateKey>`, or the `QUICKPAY_PRIVATE_KEY` env var
  (preferred). A raw key in argv (`--wallet`) leaks via `ps`, shell history, CI logs,
  and agent transcripts, so it warns — prefer the env var or `--wallet-file`.
- Token: prefer `--token-contract <address>` from the manifest. `--token <SYM>`
  is accepted only when the symbol is unique on that chain.
- RPC URL (for the on-chain transfer): `--rpc <url>`, or `QUICKPAY_RPC_<chainId>`,
  or `QUICKPAY_RPC`.

## Architecture

- `client.ts` — library-first `QuickPayClient` facade.
- `manifest.ts` — link resolution, schema validation, trust-anchor enforcement.
- `inspect.ts` / `pay.ts` — capability discovery and the x402 / MPP orchestration.
  The on-chain step is behind an injectable backend so the orchestration is unit
  tested without a chain.
- `backend-ethers.ts` — real ERC20 transfer for `pay-x402` (ethers v6).
- `backend-mpp-sdk.ts` — `pay-mpp` delegates to `goatflow-sdk`'s `MPPClient`
  (an **optional** dependency loaded at runtime).

> The live on-chain flows (the actual ERC20 transfer / MPP settlement) require a
> chain + wallet and are not exercised by the unit tests; the manifest handling,
> trust-anchor enforcement, and request orchestration are.

## Develop

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test:run    # vitest
pnpm build       # emit dist/
```
