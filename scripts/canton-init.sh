#!/usr/bin/env bash
# canton-init.sh — one-time data seed after `docker compose up -d`.
#
# Mints an initial Holding for Alice via Daml Script (uses the pre-built
# DAR committed at goatx402-canton/dist/payment-0.0.1.dar).
# Writes ./state/source-holding.json which the facilitator + e2e-cli
# read at runtime.
#
# Requires the Daml SDK on PATH (or at ~/.daml/bin/daml). Run once per
# clean `docker compose up -d` cycle; idempotent on re-run (extra
# Holdings are harmless, e2e picks the latest one).
#
# Env knobs:
#   CANTON_HOST   default localhost
#   CANTON_PORT   default 5031 (host-mapped from container 5011)
#   ISSUER_PARTY  default Issuer
#   PAYER_PARTY   default Alice
#   AMOUNT        default 100.0
#   CURRENCY      default USD-canton

set -euo pipefail

err()  { printf 'canton-init: %s\n' "$*" >&2; }
note() { printf 'canton-init: %s\n' "$*" >&2; }

# Find daml.
if ! command -v daml >/dev/null 2>&1; then
  if [[ -x "$HOME/.daml/bin/daml" ]]; then
    export PATH="$HOME/.daml/bin:$PATH"
  else
    err "daml CLI not found. Install with: curl -sSL https://get.daml.com/ | sh -s 2.10.0"
    exit 2
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAR="$REPO_ROOT/goatx402-canton/dist/payment-0.0.1.dar"
[[ -f "$DAR" ]] || { err "DAR not found: $DAR"; exit 2; }

CANTON_HOST="${CANTON_HOST:-localhost}"
CANTON_PORT="${CANTON_PORT:-5031}"
ISSUER_PARTY="${ISSUER_PARTY:-Issuer}"
PAYER_PARTY="${PAYER_PARTY:-Alice}"
AMOUNT="${AMOUNT:-100.0}"
CURRENCY="${CURRENCY:-USD-canton}"
STATE_DIR="$REPO_ROOT/state"
TOPUP_RESULT="$STATE_DIR/source-holding.json"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# Wait for the participant to be ready.
# ---------------------------------------------------------------------------
note "waiting for ${CANTON_HOST}:${CANTON_PORT}"
for i in $(seq 1 60); do
  if daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" >/dev/null

# ---------------------------------------------------------------------------
# Resolve party IDs (Issuer + Alice are allocated by bootstrap.canton).
# ---------------------------------------------------------------------------
ISSUER_ID=$(daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" --json \
  | jq -r --arg d "$ISSUER_PARTY" '.[] | select(.display_name == $d) | .party' | head -n1)
PAYER_ID=$(daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" --json \
  | jq -r --arg d "$PAYER_PARTY" '.[] | select(.display_name == $d) | .party' | head -n1)

[[ -n "$ISSUER_ID" && -n "$PAYER_ID" ]] || {
  err "could not resolve party ids — bootstrap.canton may have failed (issuer=${ISSUER_ID} payer=${PAYER_ID})"
  exit 1
}
note "Issuer = ${ISSUER_ID}"
note "Alice  = ${PAYER_ID}"

# ---------------------------------------------------------------------------
# Topup via Daml Script. Inputs / outputs are tiny JSON blobs.
# ---------------------------------------------------------------------------
INPUT=$(mktemp)
OUTPUT=$(mktemp)
trap 'rm -f "$INPUT" "$OUTPUT"' EXIT

cat > "$INPUT" <<EOF
{
  "issuer":   "${ISSUER_ID}",
  "owner":    "${PAYER_ID}",
  "amount":   "${AMOUNT}",
  "currency": "${CURRENCY}"
}
EOF

note "minting ${AMOUNT} ${CURRENCY} Holding for Alice"
daml script \
  --dar "$DAR" \
  --ledger-host "$CANTON_HOST" --ledger-port "$CANTON_PORT" \
  --script-name 'Scripts.Topup:topup' \
  --input-file "$INPUT" \
  --output-file "$OUTPUT"

CONTRACT_ID=$(jq -r '.' "$OUTPUT")
[[ -n "$CONTRACT_ID" && "$CONTRACT_ID" != "null" ]] || {
  err "topup returned no contract id"
  exit 1
}
note "minted Holding ${CONTRACT_ID}"

cat > "$TOPUP_RESULT" <<EOF
{
  "issuer_party":  "${ISSUER_ID}",
  "payer_party":   "${PAYER_ID}",
  "amount":        "${AMOUNT}",
  "currency":      "${CURRENCY}",
  "contract_id":   ${CONTRACT_ID}
}
EOF
note "wrote ${TOPUP_RESULT}"
note "init done — facilitator + e2e-cli are ready to use this Holding"
