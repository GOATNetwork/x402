#!/usr/bin/env bash
#
# canton-smoke.sh — Daml-only smoke test (PLAN.md Task 14, §8.1/§8.3).
#
# Round trip:
#   1. Wait for the Canton participant on $CANTON_PORT to report healthy.
#   2. Upload the built DAR (idempotent on the participant side).
#   3. Allocate the issuer + payer parties (idempotent).
#   4. Invoke `daml script Scripts.Topup:topup` to mint a fresh Holding.
#   5. Print the resulting contract id and exit 0.
#
# This is the "Daml works at all" gate that runs before the full
# scripts/e2e-smoke.sh suite touches the HTTP layer. It does NOT exercise
# the facilitator, merchant, or CLI — see e2e-smoke.sh for that.
#
# Environment (all optional unless marked required):
#   CANTON_HOST           default localhost
#   CANTON_PORT           default 5011 (Canton Ledger API gRPC)
#   CANTON_READY_TIMEOUT  default 60 (seconds to wait for participant up)
#   DAML_DIR              default <repo>/daml
#   DAR_PATH              default ${DAML_DIR}/.daml/dist/payment-*.dar (resolved)
#   ISSUER_PARTY          default Issuer (display name → allocated party id)
#   PAYER_PARTY           default Alice  (display name → allocated party id)
#   TOPUP_AMOUNT          default 100.0  (Daml Decimal, canonical form)
#   TOPUP_CURRENCY        default USD-canton
#   TOPUP_RESULT_PATH     default ${STATE_DIR}/source-holding.json
#   STATE_DIR             default <repo>/state
#
# Dependencies: bash, daml (Daml SDK ≥ 2.10), jq, curl (for healthz).

set -euo pipefail

err()  { printf 'canton-smoke: %s\n' "$*" >&2; }
note() { printf 'canton-smoke: %s\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing dependency: $1"
    exit 2
  fi
}

require_cmd daml
require_cmd jq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CANTON_HOST="${CANTON_HOST:-localhost}"
# Default to 5031 to match scripts/canton-up.sh's namespaced range. Export
# CANTON_PORT=5011 to talk to a vanilla canton localnet on the legacy port.
CANTON_PORT="${CANTON_PORT:-5031}"
CANTON_READY_TIMEOUT="${CANTON_READY_TIMEOUT:-60}"
DAML_DIR="${DAML_DIR:-${REPO_ROOT}/goatx402-canton/daml}"
STATE_DIR="${STATE_DIR:-${REPO_ROOT}/state}"
ISSUER_PARTY="${ISSUER_PARTY:-Issuer}"
PAYER_PARTY="${PAYER_PARTY:-Alice}"
TOPUP_AMOUNT="${TOPUP_AMOUNT:-100.0}"
TOPUP_CURRENCY="${TOPUP_CURRENCY:-USD-canton}"
TOPUP_RESULT_PATH="${TOPUP_RESULT_PATH:-${STATE_DIR}/source-holding.json}"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# 1. Wait for the participant to report ready.
# ---------------------------------------------------------------------------
wait_ready() {
  local deadline=$(( $(date +%s) + CANTON_READY_TIMEOUT ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if daml ledger list-parties \
        --host "$CANTON_HOST" --port "$CANTON_PORT" \
        >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  err "participant ${CANTON_HOST}:${CANTON_PORT} not ready within ${CANTON_READY_TIMEOUT}s"
  return 1
}

note "waiting for participant ${CANTON_HOST}:${CANTON_PORT} (timeout ${CANTON_READY_TIMEOUT}s)"
wait_ready

# ---------------------------------------------------------------------------
# 2. Resolve and upload the DAR. `daml ledger upload-dar` is documented as
#    idempotent on the participant side, so re-runs are safe.
# ---------------------------------------------------------------------------
resolve_dar() {
  if [[ -n "${DAR_PATH:-}" ]]; then
    if [[ ! -f "$DAR_PATH" ]]; then
      err "DAR_PATH=$DAR_PATH does not exist"
      exit 1
    fi
    return 0
  fi
  local dar
  dar="$(find "${DAML_DIR}/.daml/dist" -maxdepth 1 -name 'payment-*.dar' 2>/dev/null | sort | tail -n 1)"
  if [[ -z "$dar" ]]; then
    err "no built DAR under ${DAML_DIR}/.daml/dist — run 'daml build' first"
    exit 1
  fi
  DAR_PATH="$dar"
}

resolve_dar
note "uploading DAR ${DAR_PATH}"
daml ledger upload-dar \
  --host "$CANTON_HOST" --port "$CANTON_PORT" \
  "$DAR_PATH" >/dev/null

# ---------------------------------------------------------------------------
# 3. Allocate issuer + payer parties. `daml ledger allocate-parties` is
#    idempotent on display-name reuse; the second run reuses the existing
#    party id.
# ---------------------------------------------------------------------------
note "allocating parties ${ISSUER_PARTY}, ${PAYER_PARTY}"
daml ledger allocate-parties \
  --host "$CANTON_HOST" --port "$CANTON_PORT" \
  "$ISSUER_PARTY" "$PAYER_PARTY" >/dev/null

# Resolve display name -> ledger party id so the topup script gets the
# canonical id Daml expects in JSON args.
resolve_party_id() {
  local display="$1"
  daml ledger list-parties \
    --host "$CANTON_HOST" --port "$CANTON_PORT" --json 2>/dev/null \
    | jq -r --arg d "$display" '.[] | select(.display_name == $d) | .party' \
    | head -n 1
}

ISSUER_PARTY_ID="$(resolve_party_id "$ISSUER_PARTY")"
PAYER_PARTY_ID="$(resolve_party_id "$PAYER_PARTY")"
if [[ -z "$ISSUER_PARTY_ID" || -z "$PAYER_PARTY_ID" ]]; then
  err "party allocation did not resolve issuer=${ISSUER_PARTY_ID} payer=${PAYER_PARTY_ID}"
  exit 1
fi
note "issuer party id: ${ISSUER_PARTY_ID}"
note "payer  party id: ${PAYER_PARTY_ID}"

# ---------------------------------------------------------------------------
# 4. Topup: mint a fresh Holding for the bound payer. The result file is
#    written to STATE_DIR so e2e-smoke.sh can read the new sourceHolding
#    contract id between iterations (see PLAN.md §3.2.4 source-holding
#    discovery precedence).
# ---------------------------------------------------------------------------
ARGS_FILE="$(mktemp "${STATE_DIR}/topup-args.XXXXXX.json")"
RESULT_FILE="$(mktemp "${STATE_DIR}/topup-result.XXXXXX.json")"
trap 'rm -f "$ARGS_FILE" "$RESULT_FILE"' EXIT

jq -n \
  --arg issuer   "$ISSUER_PARTY_ID" \
  --arg payer    "$PAYER_PARTY_ID" \
  --arg amount   "$TOPUP_AMOUNT" \
  --arg currency "$TOPUP_CURRENCY" \
  '{issuer: $issuer, payer: $payer, amount: $amount, currency: $currency}' \
  >"$ARGS_FILE"

note "running daml-script Scripts.Topup:topup"
daml script \
  --dar "$DAR_PATH" \
  --script-name Scripts.Topup:topup \
  --ledger-host "$CANTON_HOST" --ledger-port "$CANTON_PORT" \
  --input-file  "$ARGS_FILE" \
  --output-file "$RESULT_FILE" >/dev/null

# daml-script writes either a bare string contract id or a JSON envelope.
# We accept both — strip surrounding quotes if present.
CID_RAW="$(jq -r '.' "$RESULT_FILE" 2>/dev/null || cat "$RESULT_FILE")"
CID="${CID_RAW%\"}"
CID="${CID#\"}"
if [[ -z "$CID" ]]; then
  err "topup did not produce a contract id (result file: $(cat "$RESULT_FILE"))"
  exit 1
fi

# Persist the source-holding fixture so the CLI / SPA can resolve it via
# the §3.2.4 fixture-file fallback. Keyed by partyId so multi-payer
# bring-ups stay distinct.
TMP="$(mktemp "${STATE_DIR}/.source-holding.XXXXXX.json")"
if [[ -f "$TOPUP_RESULT_PATH" ]]; then
  jq --arg p "$PAYER_PARTY_ID" --arg c "$CID" '. + {($p): $c}' \
     "$TOPUP_RESULT_PATH" >"$TMP"
else
  jq -n --arg p "$PAYER_PARTY_ID" --arg c "$CID" '{($p): $c}' >"$TMP"
fi
mv -f "$TMP" "$TOPUP_RESULT_PATH"

note "minted Holding cid=${CID} (payer=${PAYER_PARTY_ID})"
note "wrote fixture ${TOPUP_RESULT_PATH}"
note "ok"
