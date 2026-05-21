# Operator Handbook — goat-canton-payment

> **Audience**: a new developer or operator standing this repo up from a
> clean checkout, debugging an end-to-end failure, or rotating the
> participant-operator signing key.
> **Companion docs**: `README.md` (quickstart), `PLAN.md` (full design),
> `docs/x402-canton-mapping.md` (concepts).
> **Acceptance bar (F8)**: `make preflight && make canton-up && make e2e`
> completes in **under 15 minutes** on a clean checkout.

---

## 1. Prerequisites

Hard requirements (versions are pinned because Canton/Daml are sensitive to
SDK skew):

| Tool          | Version                  | Why                                                        | Install hint                                              |
| ------------- | ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------- |
| Daml SDK      | **2.10.x**               | `daml build`, `daml test`, `daml-script` topup             | `curl https://get.daml.com/ \| sh -s 2.10.0`              |
| JDK           | **17+**                  | Canton runtime (required by Daml SDK)                      | `brew install openjdk@17` / `apt install openjdk-17-jdk` |
| Docker        | 24+ (with `compose v2`)  | Canton sandbox + sequencer + mediator + participant        | https://docs.docker.com/get-docker/                       |
| Go            | **1.22+**                | facilitator, merchant, goatx402-canton-cli, goatx402-receipt             | https://go.dev/dl/                                        |
| pnpm          | 8+                       | goatx402-canton-demo                                                 | `corepack enable && corepack prepare pnpm@latest --activate` |
| Node.js       | 20+                      | goatx402-canton-demo (Vite, Playwright)                              | https://nodejs.org/                                       |
| Make + bash   | system default           | top-level orchestrator + scripts                           | (preinstalled on macOS/Linux)                             |

Optional but used by some workflows:

| Tool             | Version  | Used for                                              |
| ---------------- | -------- | ----------------------------------------------------- |
| `golangci-lint`  | latest   | `make lint`                                           |
| `bats`           | 1.10+    | `scripts/*.bats` shell unit tests                     |
| `playwright`     | bundled  | `goatx402-canton-demo` E2E (installed by `pnpm install`)        |
| `prometheus`     | any      | scraping `:8080/metrics` for the perf SLI breakdown   |
| `jq`             | any      | inspecting JSON output from CLI / curl in runbooks     |

Run the gated check before doing anything else:

```bash
make preflight
```

It verifies every hard requirement above and prints actionable install hints
for what's missing. Exit 0 means you can proceed.

---

## 2. The 15-minute happy path

From a freshly cloned tree:

```bash
# 1. Sanity check the toolchain (~1 min).
make preflight

# 2. Bring Canton up (~2 min cold). Idempotent; re-run is a no-op.
make canton-up

# 3. End-to-end smoke (~3–5 min the first time; warmer thereafter).
#    Brings up everything else, runs the CLI client 30× (5 warm-up + 25
#    measured), checks P95 < 5 s, runs E6 mid-flow canton-down test
#    and E9 cross-SDK parity (Playwright `pnpm preview` + CLI).
make e2e
```

If `make e2e` exits 0 you're done. The receipt, schema validation, latency
gate, and replay are all verified by the script.

> **Tip:** the very first invocation pulls the Canton Docker image
> (~few hundred MB) and warms the Daml SDK cache. Subsequent runs use the
> cached image and complete substantially faster.

---

## 3. `make` targets — what does what

Run `make help` for the canonical list. Conceptually:

| Target             | Action                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `make preflight`   | Check daml / jdk / docker / go / pnpm versions; print install hints on miss.             |
| `make canton-up`   | Bring up Canton localnet via Docker compose; wait for `:5011` health.                    |
| `make canton-down` | Tear down Canton localnet cleanly.                                                       |
| `make canton-status` | Print "ready" / "starting" / "down" for the local Canton stack.                        |
| `make daml-build`  | `cd daml && daml build` — produces `.daml/dist/payment-*.dar`.                            |
| `make daml-test`   | `cd daml && daml test` — runs the 7 daml-script scenarios from `PLAN.md` §6.1.            |
| `make daml-upload` | Upload DAR + allocate parties to the running participant. Idempotent.                    |
| `make keys`        | Run `scripts/init-custodial-keys.sh` — materialise `CUSTODIAL_KEY_DIR`, `PAYER_KEY_REGISTRY_PATH`, `PAYER_TOKEN_FILE`. Idempotent. |
| `make build`       | Workspace fan-out: build facilitator + merchant + goatx402-canton-cli + goatx402-receipt.              |
| `make test`        | Workspace fan-out: unit tests (`-short -count=1`).                                       |
| `make test-int`    | Workspace fan-out: integration tests (`-tags=integration`); requires `make canton-up`.    |
| `make lint`        | `golangci-lint run ./...` per Go module; `pnpm lint` for goatx402-canton-demo.                     |
| `make canton-smoke`| Daml-only smoke (`canton-up` + `daml-upload` + a single `daml-script` round trip).        |
| `make e2e`         | Full smoke: F7 acceptance gate. Orchestrates `keys`, services, CLI 30×, P95, E6, E9.    |
| `make auto`        | `preflight && canton-up && e2e` — for a fresh-VM bring-up.                              |

Every target is safe to re-run; the `keys`, `canton-up`, and `daml-upload`
targets are explicitly idempotent.

---

## 4. Environment variables

Configuration is env-driven. The full matrix lives in `PLAN.md` §5.5. The
ones that matter for first-time bring-up:

| Variable                          | Default                                                            | Used by                                  |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `CANTON_PROD`                     | `false`                                                            | facilitator + merchant (flips boot matrix to prod) |
| `CANTON_PORT`                     | `5011`                                                             | scripts + facilitator                    |
| `LEDGER_SKEW_SAFETY`              | `30s`                                                              | facilitator (Daml `expires` lenience)    |
| `COMPLETION_TTL`                  | `10m`                                                              | facilitator demux cache + LAPI dedup     |
| `RETRY_WINDOW_MAX`                | `60s` (boot-checked `< COMPLETION_TTL`)                            | facilitator sweeper                      |
| `MAX_RETRIES`                     | `3`                                                                | facilitator sweeper                      |
| `CUSTODIAL_KEY_DIR`               | `state/custodial/`                                                 | facilitator (v0)                         |
| `PAYER_KEY_REGISTRY_PATH`         | `state/payer-keys.json`                                            | facilitator                              |
| `PAYER_TOKEN_FILE`                | `state/payer-tokens.json`                                          | facilitator + CLI/web                    |
| `PARTICIPANT_SIGNING_KEY_PATH`    | `state/participant-signing.ed25519` (chmod 600)                    | facilitator `internal/receipt/sign`      |
| `PARTICIPANT_PUBKEY_PATH`         | `state/participant-pubkey.json`                                    | merchant (verifier trust anchor)         |
| `TRUSTED_ISSUER_MAP`              | `USD-canton=<canton party id of issuer>` (one entry by default)    | facilitator + merchant                    |
| `CURRENCY_ALLOWLIST`              | `USD-canton`                                                       | facilitator                              |
| `RECEIPT_MAX_AGE`                 | `5m`                                                               | merchant verifier                        |
| `RATE_LIMIT_IP_MAP_MAX`           | `10000`                                                            | facilitator middleware                   |
| `ORDER_BODY_LIMIT`                | `32KiB`                                                            | facilitator middleware                   |
| `PAYER_TOKEN` *(client)*          | (read from `PAYER_TOKEN_FILE` by smoke)                            | goatx402-canton-cli                               |
| `VITE_PAYER_TOKEN` *(goatx402-canton-demo)* | dev-only; sourced from `state/payer-tokens.json`                   | goatx402-canton-demo                               |
| `VITE_SOURCE_HOLDING_CID`         | optional                                                           | goatx402-canton-demo                               |
| `SOURCE_HOLDING_CID`              | optional                                                           | goatx402-canton-cli                               |

Where to find these in code:

- All env reads are owned by `facilitator/internal/config/config.go` (boot-time
  validation matrix) and `merchant/internal/config/config.go`. Searching for
  the name there is the most direct way to confirm semantics.
- Sensitive paths (`CUSTODIAL_KEY_DIR`, `PAYER_KEY_REGISTRY_PATH`,
  `PAYER_TOKEN_FILE`, `PARTICIPANT_SIGNING_KEY_PATH`) must be gitignored. The
  default state layout under `state/` is gitignored at the repo root.

---

## 5. Troubleshooting

Symptoms are ordered by how often they bite a new operator.

### 5.1 `make preflight` fails

| Message excerpt                              | Cause                                  | Fix                                                                       |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `daml: command not found`                    | Daml SDK not installed / not on PATH    | `curl https://get.daml.com/ \| sh -s 2.10.0`; ensure `~/.daml/bin` is on PATH |
| `daml SDK 2.x.y < 2.10.0`                    | Older Daml SDK                          | `daml install 2.10.0 --activate`                                          |
| `JDK not found` / `JAVA_HOME unset`          | No JDK 17 or `JAVA_HOME` not exported   | Install JDK 17; `export JAVA_HOME=$(/usr/libexec/java_home -v 17)` (macOS) |
| `docker: command not found`                  | Docker missing                          | Install Docker; verify `docker compose version` works                     |
| `go1.21.x ...`                                | Go older than 1.22                      | Update Go (https://go.dev/dl/)                                            |
| `pnpm not found`                             | Corepack disabled / not enabled         | `corepack enable && corepack prepare pnpm@latest --activate`              |

### 5.2 `make canton-up` hangs or fails health

```bash
# 1. What does Canton itself say?
docker compose logs --tail=200 canton

# 2. Is the port already taken?
lsof -i :${CANTON_PORT:-5011}

# 3. Is the participant just slow to start? Give it 60 s.
make canton-status
```

| Cause                                     | Fix                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Port `5011` already in use                | `export CANTON_PORT=15011 && make canton-down && make canton-up`            |
| Docker daemon not running                 | Start Docker Desktop / `sudo systemctl start docker`                        |
| Out of disk for image pull                | Free up space or `docker system prune`                                      |
| Stale Canton container holding state      | `make canton-down && docker volume prune -f && make canton-up`              |
| `RESOURCE_EXHAUSTED` from participant     | Increase Docker memory allocation to ≥ 4 GiB                                |

### 5.3 `daml build` or `daml test` fails

| Cause                                | Fix                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| SDK version mismatch with `daml.yaml` | `daml install $(grep sdk-version daml/daml.yaml \| awk '{print $2}') --activate`   |
| Stale build cache                    | `rm -rf daml/.daml && make daml-build`                                             |
| `daml-script` test asserts on missing scenario | Re-pull `daml/Tests/PaymentTest.daml`; the 7 scenarios in `PLAN.md` §6.1 are required (issuer ≠ payer ≠ merchant case included) |

### 5.4 Facilitator boot fails with `KEY_BINDING_MISMATCH`

This is the boot-time custodial-vs-registry self-check (`PLAN.md` §6.3). It
means a private key in `CUSTODIAL_KEY_DIR` does not match the public key in
`PAYER_KEY_REGISTRY_PATH` for the same `partyId`. The log line names the
offending party.

Most likely cause: a stale `state/` from a previous run. Fix:

```bash
# Nuke local state and re-init keys + tokens.
rm -rf state/custodial state/payer-keys.json state/payer-tokens.json
make keys
```

If you intentionally rotated a payer key, update both files atomically — the
registry and custodial dir must agree on `(partyId, pubkey)`.

### 5.5 Facilitator boot fails with `INVALID_CONFIG`

The boot matrix in `internal/config/config.go` rejects misconfigurations
deterministically. Common ones:

| Error                                                    | Cause                                                                     | Fix                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `RETRY_WINDOW_MAX >= COMPLETION_TTL`                     | Sweeper window would outlast the demux cache (`PLAN.md` §6.2 invariant)   | Lower `RETRY_WINDOW_MAX` or raise `COMPLETION_TTL`                   |
| `COMPLETION_TTL > maxDeduplicationDuration`              | Canton domain caps the dedup window                                       | Lower `COMPLETION_TTL` (default 10 m fits the 24 h fallback ceiling) |
| `PAYER_TOKEN_FILE missing`                               | Tokens not bootstrapped                                                   | `make keys`                                                          |
| `TRUSTED_ISSUER_MAP missing currency`                    | Currency in `CURRENCY_ALLOWLIST` has no issuer mapping                    | Add `currency=<party id>` to `TRUSTED_ISSUER_MAP`                    |
| `PARTICIPANT_SIGNING_KEY_PATH must be HSM-backed under CANTON_PROD=true` | Plain file under prod                                          | Move key into HSM-backed path or unset `CANTON_PROD`                  |

### 5.6 Client returns `MISSING_PAYER_TOKEN` or `MISSING_SOURCE_HOLDING`

Both are intentional non-zero exits with runbook lines. The fix in both cases
is to invoke the bootstrap script that materialises them:

```bash
# Bootstrap custodial keys + per-payer tokens + initial source-holding fixture.
make keys

# Or, re-run the e2e smoke (which calls all of the above):
make e2e
```

If you're running the CLI by hand, surface the token and source-holding
explicitly:

```bash
export PAYER_TOKEN=$(jq -r '."<partyId>"' state/payer-tokens.json)
export SOURCE_HOLDING_CID=$(jq -r '."<partyId>"' state/source-holding.json)
go run ./goatx402-canton-cli/cmd/x402-canton --payer <partyId> --merchant <partyId> \
   --amount 1.5 --resource /demo \
   --facilitator http://localhost:8080 --merchant-url http://localhost:7070
```

### 5.7 `409 DUPLICATE_DEDUP` / `409 DUPLICATE_CLIENT_REQUEST`

These are working as designed. The two failures are distinct:

- `DUPLICATE_DEDUP` — a previous order already exists with the same
  `(payer, amount, currency, trusted_issuer, expires_at, resource, sourceHolding, merchantRequestId, orderId, nonce)`
  preimage. Use a fresh `merchantRequestId` and a new `nonce` (the
  facilitator allocates `nonce` server-side, so most legitimate retries
  resolve automatically by varying the request).
- `DUPLICATE_CLIENT_REQUEST` — `(payer, clientRequestId)` already exists
  **and** the body fingerprint differs. The body was tampered. Send the
  original body, or send a new `clientRequestId`.

### 5.8 `504 LEDGER_TIMEOUT` / `PAYMENT_FAILED` after retries

`PAYMENT_FAILED` after `MAX_RETRIES` (default 3) means the sweeper exhausted
retries without seeing a `mediator-confirm` completion. Walk through:

```bash
# 1. Is the participant healthy?
make canton-status

# 2. Are completion events flowing? Watch the structured log:
tail -F facilitator.log | jq 'select(.order_id == "<uuid>")'

# 3. Did the offset gap metric fire? Watch the Prom counters:
curl -s :8080/metrics | grep -E 'facilitator_(skipped_offsets_total|demux_restart_loss_total)'
```

`facilitator_skipped_offsets_total > 0` means a reconnect clamped past
unseen completions (offset gap); the on-call runbook is to lower
`OFFSET_CHECKPOINT_INTERVAL` (or extend `RECONNECT_REPLAY_MAX`) and to
inspect the offset gap reported in the log. `facilitator_demux_restart_loss_total`
firing means a sweeper retry was issued during a process restart — the
recovery path is automatic (`RecoverByCommandID` against the dedup cache
or stream replay) but the counter should not stay non-zero in normal ops.

### 5.9 Merchant returns `RECEIPT_MISMATCH` / `UNKNOWN_CHALLENGE`

| Code                  | Meaning                                                                                  | Fix                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `RECEIPT_MISMATCH`    | Verifier passes but one of `amount/currency/trustedIssuer/goatx402-merchant/resource` disagreed with the merchant's expectation | The receipt is for a different order than the one currently being claimed; replay correct receipt |
| `UNKNOWN_CHALLENGE`   | `merchantRequestId` not found in the merchant's issuance LRU                             | The 402 challenge was evicted (LRU full, or stale beyond `2 × RECEIPT_MAX_AGE`); reissue 402 |
| `ErrStale`            | `completedAt + MaxAge < now`                                                              | Receipt too old; re-pay (the facilitator will reuse `commandId` if within dedup window) |
| `ErrFutureDated`      | `completedAt > now + MaxClockSkew`                                                        | Operator clock drift > 30 s; sync NTP on both hosts                                  |
| `ErrBadSignature`     | Receipt signature does not match merchant's pinned `participantPubKey` and `AcceptKeys`   | See §6 — likely mid-rotation without `AcceptKeys` deployed                           |

### 5.10 `pnpm` / Playwright steps fail in `make e2e`

```bash
cd goatx402-canton-demo
pnpm install
pnpm exec playwright install --with-deps   # one-time browser download
pnpm test                                  # vitest unit
pnpm exec playwright test                  # E2E against pnpm preview
```

If the Playwright run cannot read `VITE_PAYER_TOKEN`, verify that
`scripts/init-custodial-keys.sh` wrote `state/payer-tokens.json` and that
the Playwright fixture is sourcing it (see `goatx402-canton-demo/tests/e2e/pay.spec.ts`).

---

## 6. Participant-operator key rotation (runbook)

The merchant pins the facilitator's participant-operator public key as its
verification trust anchor. Rotating the key cannot be a hard cutover —
in-flight receipts signed by the old key would be rejected mid-flight.

The verifier supports a **double-deploy window** via
`VerifyOptions.AcceptKeys` (`PLAN.md` §6.4):

```
opts.AcceptKeys  must have len ≤ 1 (constructor-enforced)
window length    ≥ RECEIPT_MAX_AGE  (default 5 min)
                 ≤ 2 × RECEIPT_MAX_AGE  (handbook policy)
```

Procedure (single shared participant, v0 single-facilitator deployment):

1. **Generate the new key** on the facilitator host (HSM in prod, file in v0):

   ```bash
   # v0 / dev:
   PARTICIPANT_SIGNING_KEY_PATH_NEW=state/participant-signing.new.ed25519
   PARTICIPANT_PUBKEY_PATH_NEW=state/participant-pubkey.new.json
   ./scripts/init-custodial-keys.sh --participant-only \
       --out-priv "$PARTICIPANT_SIGNING_KEY_PATH_NEW" \
       --out-pub  "$PARTICIPANT_PUBKEY_PATH_NEW"
   chmod 600 "$PARTICIPANT_SIGNING_KEY_PATH_NEW"
   ```

   In prod, perform the equivalent ceremony inside the HSM.

2. **Deploy the merchant first** with `AcceptKeys = [old]` and primary
   `participantPubKey = new` (i.e. the merchant is willing to accept both
   the imminent-new key and any in-flight receipts still under the old key):

   - Update merchant's pinned `PARTICIPANT_PUBKEY_PATH` to the *new* key.
   - Set `PARTICIPANT_PUBKEY_ACCEPT_OLD_PATH` to the *old* key (the merchant
     loads this into `VerifyOptions.AcceptKeys` at boot).
   - Start the merchant; verify the rotation-window warning fires in the
     log and the deadline is logged.

3. **Cut the facilitator over** to the new private key:

   ```bash
   mv state/participant-signing.ed25519     state/participant-signing.old.ed25519
   mv state/participant-signing.new.ed25519 state/participant-signing.ed25519
   mv state/participant-pubkey.json         state/participant-pubkey.old.json
   mv state/participant-pubkey.new.json     state/participant-pubkey.json
   # Restart the facilitator. New receipts are now signed by the new key.
   ```

4. **Wait for the rotation window to elapse.** Any receipt signed by the
   old key has `completedAt + RECEIPT_MAX_AGE < now` after the window
   closes; from that point the old key is irrelevant.

5. **Remove the old key from the merchant.** Redeploy the merchant with
   `AcceptKeys` cleared (the `PARTICIPANT_PUBKEY_ACCEPT_OLD_PATH` env var
   unset). The rotation is complete.

6. **Wipe the old private key.** On the facilitator host:

   ```bash
   shred -u state/participant-signing.old.ed25519   # or HSM equivalent
   rm    state/participant-pubkey.old.json
   ```

Constraints to remember:

- `len(AcceptKeys) ≤ 1` is enforced by `VerifyOptions` construction. You
  cannot stack multiple stale keys.
- The window must close **within** `2 × RECEIPT_MAX_AGE`. The merchant logs
  the deadline at boot; if you blow past it, redeploy without
  `AcceptKeys`.
- Under `CANTON_PROD=true`, the boot check rejects plain-file private keys
  for the participant-operator role. Prod rotations are HSM-only.

---

## 7. Operational dashboards (Prometheus)

The facilitator exposes `/metrics` (`PLAN.md` §6 / Task 10). Key series for
on-call:

| Metric                                                | Type    | Watch for                                                              |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `facilitator_orders_total{status="…"}`                | counter | Sustained growth of `PAYMENT_FAILED` or `EXPIRED`                       |
| Per-stage latency histograms (`http_validate`, `lapi_submit`, `mediator_confirm_wait`, `receipt_sign`, `merchant_verify`) | histogram | P95 attribution when E7 regresses; pinpoints which stage is the offender |
| End-to-end latency histogram                          | histogram | P95 < 5 s SLO                                                          |
| `facilitator_skipped_offsets_total`                   | counter  | **Page**: any non-zero rate (silent completion drop after reconnect)    |
| `facilitator_demux_restart_loss_total`                | counter  | Non-zero is fine briefly after a restart; sustained means a sweeper is racing the demux cache |
| Canton-up gauge                                       | gauge   | 0 = unable to reach participant; correlate with `LEDGER_UNAVAILABLE` 503s |

Logs are JSONL with `order_id` correlation; redaction is deep-walk and covers
the full §9.2 rule 4 list (`Authorization`, `X-Payer-Token`, `ADMIN_TOKEN`,
`X-PAYMENT`, `signature`, `publicKey`, `payload_hash`, `submissionPayloadHash`,
`receiptPayloadHash`, `participantSig`, `dedupId`, `command_id`,
`payment_request_contract_id`). Never disable redaction in prod.

---

## 8. Hardening for production (`CANTON_PROD=true`)

Default config is localnet-only. Flipping `CANTON_PROD=true` engages a
deterministic boot matrix (`internal/config/config_prod_test.go` covers each
row). The check enforces, at minimum:

- TLS on all gRPC connections to the Canton participant.
- Canton user-management JWT (`PARTICIPANT_USER`, `PARTICIPANT_JWT_PATH`,
  chmod 600) instead of no-auth sandbox.
- `PARTICIPANT_SIGNING_KEY_PATH` HSM-backed.
- `PAYER_TOKEN_FILE`, `PAYER_KEY_REGISTRY_PATH`, `CUSTODIAL_KEY_DIR` all
  present and non-empty.
- Every entry in `CURRENCY_ALLOWLIST` has a corresponding
  `TRUSTED_ISSUER_MAP` row.
- `GET /api/v1/dev/source-holding` returns `410 ENDPOINT_RETIRED`.
- LAPI/gRPC pool + timeout knobs explicitly set (no implicit defaults).

If any row of the matrix is unsatisfied, the facilitator refuses to boot
with a structured `INVALID_CONFIG` error naming the offending field. **Do
not** patch around this; populate the env or fail closed.

---

## 9. Manual checklist for F8 acceptance (fresh-VM walkthrough)

This is the checklist a reviewer should run on a clean VM/cloud sandbox to
sign off F8. Target: under 15 minutes elapsed.

1. [ ] Clone the repo.
2. [ ] `make preflight` exits 0 (or prints actionable install hints; install
       missing tools and re-run until 0).
3. [ ] `make canton-up` returns within 60 s; `make canton-status` reports
       `ready`.
4. [ ] `make e2e` exits 0. Confirm in the log tail:
   - "DAR uploaded" line emitted.
   - `init-custodial-keys.sh` ran and the `state/` fixture files exist.
   - 30 CLI iterations completed; reported P95 < 5 s over the measured 25.
   - E6 (mid-flow canton-down) script reported `PAYMENT_CONFIRMED` after
     recovery, or `PAYMENT_FAILED` only after `MAX_RETRIES`.
   - E9 (cross-SDK parity) reports byte-identical
     `submissionPayloadHash` between CLI and `pnpm preview` browser
     bundle.
5. [ ] `curl -s :8080/metrics | grep facilitator_orders_total` shows
       per-status counters; `facilitator_skipped_offsets_total` is 0.
6. [ ] `make canton-down` cleanly stops the stack.

If any step fails, jump to §5 above; if §5 doesn't cover it, file an issue
referencing the failing step and the most recent `facilitator.log` entries
with the offending `order_id`.

---

## 10. Where to read further

| Question                                  | Read this                                              |
| ----------------------------------------- | ------------------------------------------------------ |
| Why this Daml authority model?            | `docs/x402-canton-mapping.md` §2 + `PLAN.md` §6.1       |
| What signs what?                          | `docs/x402-canton-mapping.md` §4 + `PLAN.md` §6.4       |
| Why so many dedup knobs?                  | `docs/x402-canton-mapping.md` §5 + `PLAN.md` §6.2       |
| What's the receipt schema?                | `docs/canton-receipt.schema.json` (normative)           |
| What's blocked vs deferred?               | `PLAN.md` §7 (Tasks 16/17 are deferred)                 |
| Security boundary / trust anchor framing  | `PLAN.md` §6.2 trust-anchor box + `CLAUDE.md` §5        |
