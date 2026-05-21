#!/usr/bin/env bash
# canton-init.sh — one-time data + key seed after `docker compose up -d canton-localnet`.
#
# Generates everything the facilitator + merchant need before they can start:
#   1. Participant signing keypair (ed25519, PKCS#8 PEM) for receipt signing.
#   2. Per-payer custodial keys, payer-key registry, X-Payer-Token map (Alice).
#   3. Initial Holding for Alice (Topup) → state/source-holding.json.
#   4. Merchant identity files (merchant-id.txt, issuer-id.txt) for the merchant env.
#
# Idempotent: re-running on an already-initialised state dir is safe (extra
# Holdings stack up, but the e2e picks the latest).
#
# Requires the Daml SDK + openssl + jq on the host. After this script,
# `docker compose up -d` brings the rest of the stack online.

set -euo pipefail

err()  { printf 'canton-init: %s\n' "$*" >&2; }
note() { printf 'canton-init: %s\n' "$*" >&2; }

# Find daml.
if ! command -v daml >/dev/null 2>&1; then
  if [[ -x "$HOME/.daml/bin/daml" ]]; then
    export PATH="$HOME/.daml/bin:$PATH"
  else
    err "daml CLI not found. Install: curl -sSL https://get.daml.com/ | sh -s 2.10.0"
    exit 2
  fi
fi
for cmd in openssl jq; do
  command -v "$cmd" >/dev/null || { err "$cmd not on PATH"; exit 2; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAR="$REPO_ROOT/goatx402-canton/dist/payment-0.0.1.dar"
[[ -f "$DAR" ]] || { err "DAR not found: $DAR"; exit 2; }

CANTON_HOST="${CANTON_HOST:-localhost}"
CANTON_PORT="${CANTON_PORT:-5031}"
STATE_DIR="$REPO_ROOT/state"
TOPUP_AMOUNT="${TOPUP_AMOUNT:-100.0}"
TOPUP_CURRENCY="${TOPUP_CURRENCY:-USD-canton}"
mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# 1. Wait for canton + resolve party ids (filter by party prefix; canton
#    console doesn't set display_name when parties.enable() is used).
# ---------------------------------------------------------------------------
note "waiting for canton at ${CANTON_HOST}:${CANTON_PORT}"
for _ in $(seq 1 60); do
  daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" >/dev/null 2>&1 && break
  sleep 2
done
daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" >/dev/null

resolve_party() {
  local prefix="$1"
  daml ledger list-parties --host "$CANTON_HOST" --port "$CANTON_PORT" --json 2>/dev/null \
    | jq -r --arg p "${prefix}::" '.[] | select(.party | startswith($p)) | .party' \
    | head -n1
}

ISSUER_ID=$(resolve_party "Issuer")
ALICE_ID=$(resolve_party "Alice")
FACILITATOR_ID=$(resolve_party "facilitator")
MERCHANT_ID=$(resolve_party "merchant")

for v in ISSUER_ID ALICE_ID FACILITATOR_ID MERCHANT_ID; do
  if [[ -z "${!v}" ]]; then
    err "could not resolve party for prefix derived from $v — bootstrap.canton may not have run"
    exit 1
  fi
done
note "Issuer      = ${ISSUER_ID}"
note "Alice       = ${ALICE_ID}"
note "facilitator = ${FACILITATOR_ID}"
note "merchant    = ${MERCHANT_ID}"

# ---------------------------------------------------------------------------
# 2. Participant signing key (ed25519 PKCS#8 PEM). Used by the facilitator
#    to sign CantonReceipt blobs; the merchant verifies with the matching pubkey.
# ---------------------------------------------------------------------------
# PARTICIPANT_SIGNING_KEY_PATH expects base64(raw 64-byte ed25519 private key)
# (32-byte seed + 32-byte pubkey concatenated). PARTICIPANT_PUBKEY_PATH expects
# base64(raw 32-byte pubkey). Use a small Go helper for portability — openssl
# emits PEM/DER PKCS#8 which doesn't match either format directly.
P_KEY="$STATE_DIR/participant-signing.ed25519"
P_PUB="$STATE_DIR/participant-pubkey.json"
if [[ ! -f "$P_KEY" || ! -f "$P_PUB" ]]; then
  note "generating participant signing keypair"
  go run "$REPO_ROOT/scripts/gen-signing-key.go" "$P_KEY" "$P_PUB"
  chmod 600 "$P_KEY"
fi
# trusted_issuer_map.json — informational; the env_file below is what facilitator reads.
echo "{\"$TOPUP_CURRENCY\": \"$ISSUER_ID\"}" > "$STATE_DIR/trusted-issuer-map.json"

# ---------------------------------------------------------------------------
# 3. Per-payer custodial keys + payer-key registry + X-Payer-Token map (Alice).
# ---------------------------------------------------------------------------
note "running init-custodial-keys.sh for Alice"
PAYER_PARTIES="$ALICE_ID" \
CUSTODIAL_KEY_DIR="$STATE_DIR/custodial" \
PAYER_KEY_REGISTRY_PATH="$STATE_DIR/payer-keys.json" \
PAYER_TOKEN_FILE="$STATE_DIR/payer-tokens.json" \
bash "$REPO_ROOT/scripts/init-custodial-keys.sh"

# ---------------------------------------------------------------------------
# 4. Mint an initial Holding for Alice via Scripts.Topup:topup.
# ---------------------------------------------------------------------------
TOPUP_RESULT="$STATE_DIR/source-holding.json"

INPUT=$(mktemp) ; OUTPUT=$(mktemp)
trap 'rm -f "$INPUT" "$OUTPUT"' EXIT

cat > "$INPUT" <<EOF
{
  "issuer":   "${ISSUER_ID}",
  "payer":    "${ALICE_ID}",
  "amount":   "${TOPUP_AMOUNT}",
  "currency": "${TOPUP_CURRENCY}"
}
EOF

note "minting ${TOPUP_AMOUNT} ${TOPUP_CURRENCY} Holding for Alice"
daml script \
  --dar "$DAR" \
  --ledger-host "$CANTON_HOST" --ledger-port "$CANTON_PORT" \
  --script-name 'Scripts.Topup:topup' \
  --input-file "$INPUT" \
  --output-file "$OUTPUT"

CONTRACT_ID=$(jq -r '.' "$OUTPUT")
[[ -n "$CONTRACT_ID" && "$CONTRACT_ID" != "null" ]] || { err "topup returned no contract id"; exit 1; }
note "minted Holding ${CONTRACT_ID}"

# contract_id is a hex string; use --arg (not --argjson).
jq -n \
  --arg issuer "$ISSUER_ID" \
  --arg payer "$ALICE_ID" \
  --arg amount "$TOPUP_AMOUNT" \
  --arg currency "$TOPUP_CURRENCY" \
  --arg cid "$CONTRACT_ID" \
  '{issuer_party: $issuer, payer_party: $payer, amount: $amount, currency: $currency, contract_id: $cid}' \
  > "$TOPUP_RESULT"
note "wrote $TOPUP_RESULT"

# Also write the source-holding map shape the dev_source_holding endpoint expects:
# { partyId: contractId }
jq -n --arg p "$ALICE_ID" --arg cid "$CONTRACT_ID" '{($p): $cid}' \
  > "$STATE_DIR/source-holding-map.json"

# ---------------------------------------------------------------------------
# 5. Merchant identity files (the merchant env reads these at boot).
# ---------------------------------------------------------------------------
echo -n "$MERCHANT_ID" > "$STATE_DIR/merchant-id.txt"
echo -n "$ISSUER_ID"   > "$STATE_DIR/issuer-id.txt"

# ---------------------------------------------------------------------------
# 6. Generated env_files consumed by docker-compose (facilitator/merchant).
# ---------------------------------------------------------------------------
cat > "$STATE_DIR/facilitator.env" <<EOF
TRUSTED_ISSUER_MAP={"${TOPUP_CURRENCY}":"${ISSUER_ID}"}
CURRENCY_ALLOW_LIST=${TOPUP_CURRENCY}
EOF

cat > "$STATE_DIR/merchant.env" <<EOF
MERCHANT_PARTY_ID=${MERCHANT_ID}
MERCHANT_TRUSTED_ISSUER=${ISSUER_ID}
MERCHANT_RESOURCE=/resource
MERCHANT_AMOUNT=1.00
MERCHANT_CURRENCY=${TOPUP_CURRENCY}
EOF

note "init done — ready for: docker compose up -d facilitator merchant canton-demo"
