# goatx402-canton — Canton-daml settlement backend for x402

This directory documents the `canton/initial-port` branch's contributions:
a self-hosted x402 facilitator + demo merchant + clients that speak the
`canton-daml` scheme against a Canton/Daml ledger.

## Quick start (one command)

From the branch root:

```bash
docker compose up -d
```

This brings up:

| Service          | Container name              | Host port | Role                                      |
| ---------------- | --------------------------- | --------- | ----------------------------------------- |
| canton-localnet  | goatx402-canton-localnet    | 5031–5039 | Canton participant + domain               |
| daml-bootstrap   | goatx402-canton-bootstrap   | —         | One-shot: build DAR, upload, alloc parties, topup |
| facilitator      | goatx402-facilitator        | 8080      | x402 server (canton-daml scheme)          |
| merchant         | goatx402-merchant           | 7070      | Demo paywall + offline receipt verifier   |
| canton-demo      | goatx402-canton-demo        | 4173      | Vite/React SPA client                     |

The compose network is named `goatx402-canton`; services reach each other by
DNS name (`canton-localnet`, `facilitator`, `merchant`).

## Verifying it's up

```bash
# 1. All containers healthy / running
docker compose ps

# 2. Canton ready marker
docker logs goatx402-canton-localnet | grep "goatx402 canton localnet ready"

# 3. Bootstrap finished
docker logs goatx402-canton-bootstrap | grep "bootstrap done"
cat state/source-holding.json   # facilitator's seed Holding for Alice

# 4. Facilitator serving
curl -s http://localhost:8080/healthz

# 5. Merchant returning 402
curl -s -i http://localhost:7070/resource | head -5  # expect 402 + PAYMENT-REQUIRED header

# 6. SPA reachable
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4173/   # expect 200
```

## End-to-end (one payment round-trip)

The `e2e-cli` service is opt-in via the `e2e` compose profile:

```bash
docker compose --profile e2e run --rm e2e-cli \
  --merchant-url http://merchant:7070 \
  --facilitator http://facilitator:8080 \
  --resource /resource \
  --payer-token "$(jq -r '.Alice' state/payer-tokens.json)" \
  --source-holding "$(jq -r '.contract_id' state/source-holding.json)"
```

The CLI implements the 10-step flow documented in
[`docs/canton/x402-canton-mapping.md`](x402-canton-mapping.md) — discover 402,
create order, sign, submit, fetch receipt, present to merchant.

## Module map

```
goatx402-canton/         Daml templates + Canton bootstrap config + daml-sdk Dockerfile
goatx402-receipt/        Canonical receipt schema + offline verifier (Go module)
goatx402-facilitator/    HTTP server: x402 routes + Canton gRPC client (Go module)
goatx402-merchant/       Demo paywall: 402 issuer + offline receipt verifier (Go module)
goatx402-canton-cli/     Reference CLI client (Go module)
goatx402-canton-demo/    Vite/React SPA demo client
scripts/                 canton-up/down/smoke + init-custodial-keys
docs/canton/             this directory
docs/canton-receipt.schema.json   JSON Schema for CantonReceipt
```

## Why a separate scheme?

x402's envelope can carry multiple `accepts[]` entries each with its own
`scheme`. The canton-daml scheme is for settlement on Canton/Daml ledgers —
no chain id, no ERC-20 contract, no EIP-712 signing. Receipt is a `CantonReceipt`
JSON containing `{ledgerId, transactionId, contractId, …}`, verifiable
offline against the participant's public key.

The branch keeps the upstream EVM scheme (`evm-eip3009` / `evm-permit2`)
unchanged — implementations choose their scheme per merchant.

## Operator handbook

See [`operator-handbook.md`](operator-handbook.md) for production hardening:
real OIDC, HSM-backed participant signing key, persistent postgres for the
facilitator store, monitoring, backup.

## Preflight + decisions

Before any changes were made, the team captured the existing canton-payment
runtime, image SHAs, helper duplication, and the Daml SDK install path in
[`preflight-notes.md`](preflight-notes.md). The high-level plan + 5 binding
decisions (module prefix, receipt module shape, branch hosting, LICENSE
scope, SDK scope) live in [`port-plan.html`](port-plan.html).

## Status

Branch is `canton/initial-port` off `GOATNetwork/x402:main`. PR opens after
G3 (CI green for 3 consecutive pushes) and internal review.
