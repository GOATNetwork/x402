# Stage 0.5 preflight notes

Captured before Stage 1 begins so that surprises surface early and CI can pin
the right artefacts.

## Canton image (for CI pinning)

```
Image: digitalasset/canton-open-source
Pinned digest:
  sha256:98068c061913cdfaa3898b480a2c0a343b59144d3942678a4929cadb51e5f52a
Image ID (short): 5a427e812e7b
Image size: 691 MB
Status on dev host: container `canton-localnet-goat-canton-payment` Up 6 days
```

CI workflows (`.github/workflows/canton.yml`) MUST pin the digest, not the
`:latest` tag. Use:

```yaml
services:
  canton:
    image: digitalasset/canton-open-source@sha256:98068c061913cdfaa3898b480a2c0a343b59144d3942678a4929cadb51e5f52a
```

Same digest goes into the top-level `docker-compose.yml` introduced at Stage 5.

## Daml SDK availability

- `daml` CLI is **not installed** on the development host.
- The Canton image **does not** ship Daml SDK either; it only provides the Canton runtime.
- Required SDK version (per `daml/daml.yaml` in the canton-payment tree): `2.10.0`.

Implication for the port: do **not** require the host to install Daml SDK.
Build the DAR inside a container instead. Two options:

1. **Multi-stage Dockerfile**: use `digitalasset/daml-sdk:2.10.0` as a builder
   stage that runs `daml build` and produces the DAR, then COPY into the
   facilitator's runtime image. Recommended for `docker-compose up -d`
   single-command workflow.
2. **CI setup-action**: GitHub Actions installs Daml SDK via the official
   tarball with a cache key on SDK version (`~/.daml/sdk/2.10.0` cached).

Both will be used: Dockerfile path for local dev, setup-action for CI.

## Facilitator-internal canonical helpers (NOT moved to goatx402-receipt)

Per v3 §1 decision the receipt module stays standalone and these helpers
remain inside the facilitator. They live at
`projects/goat-canton-payment/facilitator/internal/api/orders.go:459-557`:

| Identifier | Line | Kind |
|---|---|---|
| `CanonicalSubmissionDomain` | 459 | const |
| `CanonicalDedupDomain` | 463 | const |
| `CanonicalFingerprintDomain` | 467 | const |
| `DedupInput` | 471 | struct |
| `CanonicalDedupInput` | 487 | func |
| `CanonicalSubmission` | 522 | func |
| `CanonicalRequestFingerprint` | 557 | func |

These are duplicated wrt `pkg/receipt/CantonReceipt.Canonical` in the sense
that they share the lexicographic-sort + UTF-8 NFC discipline. They are not
exported by `pkg/receipt` and v3 explicitly does not migrate them. Filed as
a follow-up after G3:
`TODO(post-G3): hoist Canonical{Submission,DedupInput,RequestFingerprint}
into goatx402-receipt`.

## Public API surface of pkg/receipt → goatx402-receipt

Captured via `go doc ./pkg/receipt`:

```
type CantonReceipt struct { ... }
  func (r *CantonReceipt) Canonical() ([]byte, error)
  func (r *CantonReceipt) Verify(verifier Verifier) error
  ... (full surface to be re-captured during Stage 2 build)
```

Move-as-is. Stage 2 will run `go doc ./goatx402-receipt` after the rename
and diff against this baseline; any unintended surface change is a Stage 2
regression.

## Scripts inventory (verified to exist before being declared "verbatim copy")

From `/Users/drej/workspace/goat-canton-payment/projects/goat-canton-payment/scripts/`:

| File | Purpose | Action |
|---|---|---|
| `canton-up.sh` | restart wrapper (delegates to harness-level when container missing) | merge with harness, become self-contained |
| `canton-down.sh` | stop container | verbatim copy |
| `canton-smoke.sh` | DAR upload + topup | verbatim copy, rewrite paths |
| `e2e-smoke.sh` | the main 30-iteration smoke | port + rewrite paths + binaries |
| `e2e-canton-down-midflow.sh` | chaos test (E6) | port + rewrite paths |
| `init-custodial-keys.sh` | per-payer ed25519 + tokens | verbatim copy |
| `init-custodial-keys.bats` | tests for above | verbatim copy |
| `e2e-cross-sdk-parity.sh` | **does NOT exist** despite v3 §4 listing it | drop from copy list; if a future stage needs it, write fresh |

Harness-level (`/Users/drej/workspace/goat-canton-payment/scripts/canton-up.sh`):
exists; it's the script that actually creates the container + runs
`bootstrap.canton`. The branch's `scripts/canton-up.sh` will absorb both
the harness-level and project-level scripts into one self-contained file.

## Binary names (correct names, NOT what v3 v1 wrote)

From `scripts/e2e-smoke.sh:239-241`:

```bash
cd ${REPO_ROOT}/facilitator && go build -o $FACILITATOR_BIN ./cmd/server
cd ${REPO_ROOT}/merchant    && go build -o $MERCHANT_BIN    ./cmd/server
cd ${REPO_ROOT}/client-cli  && go build -o $CLI_BIN         ./cmd/x402-canton
```

With env defaults:

```
FACILITATOR_BIN = ${REPO_ROOT}/facilitator/bin/facilitator
MERCHANT_BIN    = ${REPO_ROOT}/merchant/bin/merchant
CLI_BIN         = ${REPO_ROOT}/client-cli/bin/x402-canton
```

→ On the branch the binary names stay the same:

```
goatx402-facilitator/bin/facilitator
goatx402-merchant/bin/merchant
goatx402-canton-cli/bin/x402-canton
```

`cmd/` subdirs also stay: `cmd/server` for facilitator + merchant, `cmd/x402-canton`
for the CLI.

## Real-network env-var contract (Stage 9 — informational only, deferred)

`projects/goat-canton-payment/facilitator/internal/config/config.go:115-127, 303-340`
reveals the real prod config matrix:

```
CANTON_PROD=true
PARTICIPANT_HOST=...
PARTICIPANT_PORT=...
PARTICIPANT_TLS=true
PARTICIPANT_USER=...
PARTICIPANT_JWT_PATH=/path/to/jwt
PARTICIPANT_SIGNING_KEY_PATH=/path/to/HSM-backed key
PARTICIPANT_FINGERPRINT=...
PARTICIPANT_PUBKEY_PATH=...
```

The earlier port-plan reference to a single `PARTICIPANT_JWT` env var is
wrong. Stage 9 (if it ever runs) must use the full matrix above. For the
initial port we run against localnet only — Stage 9 is deferred until after
G3.

## Source-holding fixture (R3 missing item)

Two sources of truth in the canton impl:

- `state/source-holding.json` written by `scripts/canton-smoke.sh` (used by e2e)
- `~/.goat-canton/source-holding.json` default-fallback in
  `client-cli/internal/holding/discover.go`

Port decision: the branch standardises on **`./state/source-holding.json`**
(repo-local), and the CLI's default-fallback path is changed to look at
`./state/source-holding.json` first, `~/.goat-canton/source-holding.json`
second. Single canonical location for both local dev and CI.

## Stage 0 cold-start baseline

Existing `goatx402-sdk-server-go` builds and vets clean on a fresh clone:

```
$ cd goatx402-sdk-server-go && go build ./... && go vet ./...
# exit 0
```

This baseline must remain green after every subsequent stage.
