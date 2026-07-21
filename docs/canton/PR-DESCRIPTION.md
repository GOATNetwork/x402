# PR description — canton/initial-port → main

**Branch:** [`anvztor/x402:canton/initial-port`](https://github.com/anvztor/x402/tree/canton/initial-port)  →  `GOATNetwork/x402:main`

## Summary

Adds a complete `canton-daml` settlement backend to the x402 reference
implementation: Daml templates, a self-hosted facilitator (Go), a demo
merchant (Go), a CLI client (Go), and a browser SPA — all reachable via
a single `docker compose up -d`.

The contribution is **100 % additive**. Every upstream file
(`goatx402-sdk-server-go`, `goatx402-sdk`, `goatx402-sdk-server-ts`,
`goatx402-demo`, `goatx402-contract`, `API.md`, `DEVELOPER_FAST.md`,
`ONBOARDING.md`, `README.md`) is unchanged.

## What's new

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
docker-compose.yml       one-shot bring-up of the whole stack
.dockerignore            build-context optimisation
.github/workflows/canton.yml      3-job CI (baseline / canton-modules / canton-stack)
LICENSE-canton-port      Apache-2.0 scope-limited to net-new files
Makefile                 top-level orchestration (canton-up/down/smoke/e2e)
go.work                  workspace listing all 4 canton modules + upstream SDK
```

Upstream EVM stack files: **not touched**.

## Design decisions (recorded in `docs/canton/port-plan.html` §1)

1. **Module prefix**: `github.com/goatnetwork/<pkgname>` to match upstream's
   existing `github.com/goatnetwork/goatx402-sdk-server` shape (no `/x402/`
   path segment).
2. **Receipt module**: kept **standalone** (`goatx402-receipt/`), not folded
   into facilitator. Reason: facilitator's `internal/api/orders.go:446`
   currently has canonical helpers that `pkg/receipt` doesn't export;
   folding would carry that duplication forward.
3. **Branch hosting**: personal fork; can migrate to a GOATNetwork-org fork
   on request.
4. **LICENSE**: Apache-2.0, scoped to **net-new files only** via
   `LICENSE-canton-port`. Does not relicense any inherited upstream file.
   A separate governance issue is being opened proposing a repo-level
   LICENSE for maintainers to decide.
5. **SDK extension dropped**: upstream `goatx402-sdk-server-go` is a
   client SDK to GoatX402 Core (EVM). Its request/response bodies don't
   match the canton facilitator's (canton uses `{merchant, payer, amount,
   currency, trustedIssuer, …}`, Core uses `{dapp_order_id, chain_id,
   token_symbol, …}`), so just swapping `AuthScheme` wouldn't enable
   canton routing. A Canton-aware SDK client is out of scope for this
   port — happy to follow up if desired.

## Testing

### Quick start

```bash
docker compose up -d            # canton-localnet + daml-bootstrap + facilitator + merchant + canton-demo
curl http://localhost:8080/healthz                    # facilitator
curl -i http://localhost:7070/resource | head -5      # merchant returns 402
open http://localhost:4173                            # SPA
```

### E2E

```bash
docker compose --profile e2e run --rm e2e-cli \
  --merchant-url   http://merchant:7070 \
  --facilitator    http://facilitator:8080 \
  --resource       /resource \
  --payer-token    "$(jq -r '.Alice' state/payer-tokens.json)" \
  --source-holding "$(jq -r '.contract_id' state/source-holding.json)"
```

### Acceptance gates (G1-G4 from `port-plan.html`)

| Gate | Stage | Status |
|------|-------|--------|
| G1 — facilitator builds + unit tests pass under new module paths | Stage 2 | ✅ |
| G2 — e2e-smoke green under perf gate                              | Stage 5 | pending validator final review |
| G3 — branch CI green for 3 consecutive pushes                    | Stage 7 | pending workflow first run |
| G4 — internal team agrees branch is in good shape                | post-G3 | pending |

## What's intentionally **not** in this PR

- Spec/`API.md` additions registering the `canton-daml` scheme — propose
  as a follow-up doc PR once this lands.
- TS SDK canton support (`goatx402-sdk`, `goatx402-sdk-server-ts`) — same
  pattern as the Go SDK refactor (also out of scope here).
- Solidity callback contract changes — canton flow does not use the
  EVM callback contract.
- Replacing GoatX402 Core — explicit non-goal. The canton facilitator is
  a sibling, not a replacement.

## Things to look at first

If you only have 10 minutes, read in this order:

1. `docs/canton/port-plan.html` §1-§4 — what's added and why.
2. `docs/canton/x402-canton-mapping.md` — how the x402 envelope maps to
   Canton primitives.
3. `goatx402-canton/daml/Payment.daml` (74 lines) — the entire Daml model.
4. `goatx402-facilitator/internal/api/router.go` (~50 lines) — the HTTP surface.
5. `docker-compose.yml` — how the pieces fit at runtime.

## Open questions

1. Module-path prefix preference: we chose `github.com/goatnetwork/<pkg>`
   to match `goatx402-sdk-server-go`'s existing shape. Comfortable, or
   prefer `github.com/goatnetwork/x402/<pkg>`?
2. Should this live in-tree (as siblings of `goatx402-sdk-server-go`) or
   in a separate `GOATNetwork/x402-canton` repo with cross-repo CI?
3. Are you open to a follow-up that adds a `canton-daml` registry entry
   to `API.md`'s scheme list?
4. License preference for the repo root (currently absent)?

## Companion change in `GOATNetwork/giftcard`

A parallel branch `feat/canton-payment` adds `CantonX402SDK` in
`gift-api/internal/x402_canton/` so giftcard can use the canton facilitator
as an alternative settlement backend. That branch is local-only — the
giftcard repo has forks disabled, so it cannot be pushed via the standard
GitHub fork-PR flow. Available on request as a patch series or via direct
push by a maintainer.

---

Generated from `docs/canton/port-plan.html`. Internal review by Claude × Codex
cross-review (3 rounds; Round 3 verdict: ship with minor clarifications,
all applied). See `docs/canton/port-plan.html` footer for review trail.
