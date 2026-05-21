#!/usr/bin/env bash
# canton-bootstrap.sh — run inside the goatx402-canton-bootstrap container
# (built from goatx402-canton/Dockerfile.bootstrap) to drive a fresh
# canton-localnet to a known-good state.
#
# Steps:
#   1. Wait for canton-localnet on $CANTON_HOST:$CANTON_PORT (gRPC).
#   2. daml build → produces /workspace/daml/.daml/dist/payment-*.dar
#   3. daml ledger upload-dar (idempotent — duplicate DAR uploads are no-ops).
#   4. Allocate Issuer + Alice parties (idempotent).
#   5. Run `daml script` against Scripts.Topup:topup to mint a Holding.
#   6. Write the resulting ContractId + party ids to $STATE_DIR/source-holding.json.
#
# Idempotent: re-running after success replaces source-holding.json with a
# fresh Holding (Alice may end up with multiple Holdings; downstream e2e
# resolves the latest one).
#
# Env (with defaults):
#   CANTON_HOST           canton-localnet      # docker-compose service hostname
#   CANTON_PORT           5011                  # gRPC ledger api INSIDE the network
#   CANTON_READY_TIMEOUT  120
#   STATE_DIR             /state                # bind-mounted from host
#   ISSUER_PARTY          Issuer
#   PAYER_PARTY           Alice
#   TOPUP_AMOUNT          100.0
#   TOPUP_CURRENCY        USD-canton
#   DAML_DIR              /workspace/daml

set -euo pipefail

err()  { printf 'canton-bootstrap: %s\n' "$*" >&2; }
note() { printf 'canton-bootstrap: %s\n' "$*" >&2; }

CANTON_HOST="${CANTON_HOST:-canton-localnet}"
CANTON_PORT="${CANTON_PORT:-5011}"
CANTON_READY_TIMEOUT="${CANTON_READY_TIMEOUT:-120}"
STATE_DIR="${STATE_DIR:-/state}"
ISSUER_PARTY="${ISSUER_PARTY:-Issuer}"
PAYER_PARTY="${PAYER_PARTY:-Alice}"
TOPUP_AMOUNT="${TOPUP_AMOUNT:-100.0}"
TOPUP_CURRENCY="${TOPUP_CURRENCY:-USD-canton}"
DAML_DIR="${DAML_DIR:-/workspace/daml}"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# 1. Wait for participant.
# ---------------------------------------------------------------------------
note "waiting up to ${CANTON_READY_TIMEOUT}s for ${CANTON_HOST}:${CANTON_PORT}"
deadline=$(( $(date +%s) + CANTON_READY_TIMEOUT ))
while (( $(date +%s) < deadline )); do
  if (nc -z "$CANTON_HOST" "$CANTON_PORT") >/dev/null 2>&1; then
    # Probe with daml — TCP alone is not enough (canton boots in stages).
    if daml ledger list-parties \
        --host "$CANTON_HOST" --port "$CANTON_PORT" \
        >/dev/null 2>&1; then
      note "participant ready"
      break
    fi
  fi
  sleep 2
done
if ! daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" >/dev/null 2>&1; then
  err "participant ${CANTON_HOST}:${CANTON_PORT} not ready within ${CANTON_READY_TIMEOUT}s"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Build DAR.
# ---------------------------------------------------------------------------
note "building DAR in ${DAML_DIR}"
( cd "$DAML_DIR" && daml build )
DAR=$(ls "$DAML_DIR"/.daml/dist/payment-*.dar | head -n1)
[[ -f "$DAR" ]] || { err "DAR build produced no file in ${DAML_DIR}/.daml/dist/"; exit 1; }
note "built $DAR"

# ---------------------------------------------------------------------------
# 3. Upload DAR.
# ---------------------------------------------------------------------------
note "uploading DAR"
daml ledger upload-dar "$DAR" --host "$CANTON_HOST" --port "$CANTON_PORT"

# ---------------------------------------------------------------------------
# 4. Allocate parties (idempotent — daml allocate-parties dedup by display name).
# ---------------------------------------------------------------------------
ensure_party() {
  local display="$1"
  local existing
  existing=$(daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" --json 2>/dev/null \
              | jq -r --arg d "$display" '.[] | select(.display_name == $d) | .party' | head -n1)
  if [[ -n "$existing" && "$existing" != "null" ]]; then
    note "party '${display}' already allocated -> ${existing}"
    echo "$existing"
    return 0
  fi
  note "allocating party '${display}'"
  daml ledger allocate-parties \
    --host "$CANTON_HOST" --port "$CANTON_PORT" \
    "$display" >/dev/null
  daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" --json \
    | jq -r --arg d "$display" '.[] | select(.display_name == $d) | .party' | head -n1
}

ISSUER_PARTY_ID=$(ensure_party "$ISSUER_PARTY")
PAYER_PARTY_ID=$(ensure_party "$PAYER_PARTY")

[[ -n "$ISSUER_PARTY_ID" && -n "$PAYER_PARTY_ID" ]] || {
  err "could not resolve party ids (issuer=${ISSUER_PARTY_ID} payer=${PAYER_PARTY_ID})"
  exit 1
}
note "issuer=${ISSUER_PARTY_ID}"
note "payer=${PAYER_PARTY_ID}"

# ---------------------------------------------------------------------------
# 5. Topup via Scripts.Topup:topup.
# ---------------------------------------------------------------------------
note "running Scripts.Topup:topup (mint ${TOPUP_AMOUNT} ${TOPUP_CURRENCY})"
INPUT_FILE=$(mktemp)
cat > "$INPUT_FILE" <<EOF
{
  "issuer":   "${ISSUER_PARTY_ID}",
  "owner":    "${PAYER_PARTY_ID}",
  "amount":   "${TOPUP_AMOUNT}",
  "currency": "${TOPUP_CURRENCY}"
}
EOF

OUTPUT_FILE=$(mktemp)
daml script \
  --dar "$DAR" \
  --ledger-host "$CANTON_HOST" --ledger-port "$CANTON_PORT" \
  --script-name 'Scripts.Topup:topup' \
  --input-file "$INPUT_FILE" \
  --output-file "$OUTPUT_FILE"

# Scripts.Topup:topup returns the ContractId Holding as a JSON string.
CONTRACT_ID=$(jq -r '.' "$OUTPUT_FILE")
[[ -n "$CONTRACT_ID" && "$CONTRACT_ID" != "null" ]] || {
  err "topup returned no contract id (output: $(cat "$OUTPUT_FILE"))"
  exit 1
}
note "minted Holding: ${CONTRACT_ID}"

# ---------------------------------------------------------------------------
# 6. Persist source-holding.json.
# ---------------------------------------------------------------------------
cat > "$STATE_DIR/source-holding.json" <<EOF
{
  "issuer_party":  "${ISSUER_PARTY_ID}",
  "payer_party":   "${PAYER_PARTY_ID}",
  "amount":        "${TOPUP_AMOUNT}",
  "currency":      "${TOPUP_CURRENCY}",
  "contract_id":   ${CONTRACT_ID}
}
EOF
note "wrote ${STATE_DIR}/source-holding.json"

note "bootstrap done"
