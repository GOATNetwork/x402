#!/usr/bin/env bash
#
# init-custodial-keys.sh — materialise per-payer custodial Ed25519 keys, the
# payer-key registry, and the X-Payer-Token map (PLAN.md Task 6).
#
# Resolves the round-3 P1: `make e2e` on a fresh checkout had no way to
# materialise per-payer custodial keys (scripts/canton-up.sh only generates
# the participant-operator key per §6.4). Idempotent: existing party rows
# are preserved across re-runs.
#
# Invoked by:
#   - scripts/canton-up.sh    (after participant readiness)
#   - scripts/e2e-smoke.sh    (before facilitator startup)
#
# Environment:
#   PAYER_PARTIES            comma-separated Canton party ids (also accepted
#                            as positional args; either is fine, not both)
#   CUSTODIAL_KEY_DIR        directory for <party>.ed25519 PEM private keys
#                            (chmod 600 per-file; one file per party)
#   PAYER_KEY_REGISTRY_PATH  JSON map { partyId: base64(raw 32-byte pubkey) }
#   PAYER_TOKEN_FILE         JSON map { partyId: base64(raw 32-byte token) }
#
# Dependencies: bash, openssl, jq.
#
# Key format (PLAN.md §6.3): every <party>.ed25519 is a PEM-encoded PKCS#8
# Ed25519 private key — exactly what `openssl genpkey -algorithm Ed25519`
# emits. The facilitator's CustodialSigner consumes the same format via
# Go's x509.ParsePKCS8PrivateKey, so this script and the loader stay in
# lockstep without any custom binary encoding.

set -euo pipefail

err()  { printf 'init-custodial-keys: %s\n' "$*" >&2; }
note() { printf 'init-custodial-keys: %s\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing dependency: $1"
    exit 2
  fi
}

require_cmd openssl
require_cmd jq

# ---------------------------------------------------------------------------
# Parse PAYER_PARTIES (env or argv). Reject "both at once" to keep the
# config provenance unambiguous when this script is wired into canton-up.sh
# and e2e-smoke.sh.
# ---------------------------------------------------------------------------
PARTIES_INPUT="${PAYER_PARTIES:-}"
if [[ $# -gt 0 ]]; then
  if [[ -n "$PARTIES_INPUT" ]]; then
    err "supply PAYER_PARTIES via env OR positional args, not both"
    exit 2
  fi
  PARTIES_INPUT="$(IFS=,; echo "$*")"
fi
if [[ -z "$PARTIES_INPUT" ]]; then
  err "PAYER_PARTIES not set (env or argv); pass a comma-separated list"
  exit 2
fi

: "${CUSTODIAL_KEY_DIR:?CUSTODIAL_KEY_DIR not set}"
: "${PAYER_KEY_REGISTRY_PATH:?PAYER_KEY_REGISTRY_PATH not set}"
: "${PAYER_TOKEN_FILE:?PAYER_TOKEN_FILE not set}"

# ---------------------------------------------------------------------------
# Filesystem prep. The key dir is private-by-default (chmod 700). The two
# JSON sidecars start as `{}` so jq can do additive updates.
# ---------------------------------------------------------------------------
mkdir -p "$CUSTODIAL_KEY_DIR"
chmod 700 "$CUSTODIAL_KEY_DIR" 2>/dev/null || true

ensure_json_object() {
  local path="$1"
  local parent
  parent="$(dirname "$path")"
  mkdir -p "$parent"
  if [[ ! -f "$path" ]]; then
    printf '{}' >"$path"
    chmod 600 "$path"
    return
  fi
  if ! jq -e 'type == "object"' "$path" >/dev/null 2>&1; then
    err "$path exists but is not a JSON object"
    exit 2
  fi
}

ensure_json_object "$PAYER_KEY_REGISTRY_PATH"
ensure_json_object "$PAYER_TOKEN_FILE"

# Replace a JSON file atomically. mktemp inside the same directory so the
# rename is filesystem-local. chmod 600 on the temp ahead of the rename so
# the destination never sits with looser permissions even transiently.
write_atomic() {
  local path="$1"
  local content="$2"
  local dir tmp
  dir="$(dirname "$path")"
  tmp="$(mktemp "${dir}/.$(basename "$path").XXXXXX")"
  chmod 600 "$tmp"
  printf '%s\n' "$content" >"$tmp"
  mv -f "$tmp" "$path"
}

# ---------------------------------------------------------------------------
# Per-party generation. Three side effects per party, each conditionally
# applied so re-runs are no-ops:
#   1. <CUSTODIAL_KEY_DIR>/<party>.ed25519  (PEM PKCS#8 priv key, chmod 600)
#   2. <PAYER_KEY_REGISTRY_PATH>            (base64 pubkey, derived from above)
#   3. <PAYER_TOKEN_FILE>                   (base64 32-byte random token)
# ---------------------------------------------------------------------------
init_party() {
  local party="$1"
  local pem_file="${CUSTODIAL_KEY_DIR}/${party}${PEM_SUFFIX}"

  if [[ ! -f "$pem_file" ]]; then
    # openssl writes a PEM PKCS#8 Ed25519 private key. Capture both halves in
    # one umask-tight section so the file never sits at mode 644 momentarily.
    local prev_umask
    prev_umask="$(umask)"
    umask 077
    openssl genpkey -algorithm Ed25519 -out "$pem_file" 2>/dev/null
    umask "$prev_umask"
    chmod 600 "$pem_file"
    note "generated key for party ${party}"
  fi

  # Registry: skip when already present.
  if ! jq -e --arg p "$party" 'has($p)' "$PAYER_KEY_REGISTRY_PATH" >/dev/null; then
    local pub_b64
    pub_b64="$(openssl pkey -in "$pem_file" -pubout -outform DER 2>/dev/null \
               | tail -c 32 | base64 | tr -d '\n')"
    local updated
    updated="$(jq --arg p "$party" --arg k "$pub_b64" '. + {($p): $k}' \
               "$PAYER_KEY_REGISTRY_PATH")"
    write_atomic "$PAYER_KEY_REGISTRY_PATH" "$updated"
    note "added registry entry for party ${party}"
  fi

  # Token: skip when already present. Random 32 raw bytes → base64 (44 chars
  # incl. padding). Matches the §5.5 PAYER_TOKEN_FILE format pin.
  if ! jq -e --arg p "$party" 'has($p)' "$PAYER_TOKEN_FILE" >/dev/null; then
    local token_b64
    token_b64="$(openssl rand 32 | base64 | tr -d '\n')"
    local updated
    updated="$(jq --arg p "$party" --arg t "$token_b64" '. + {($p): $t}' \
               "$PAYER_TOKEN_FILE")"
    write_atomic "$PAYER_TOKEN_FILE" "$updated"
    note "added X-Payer-Token for party ${party}"
  fi
}

# CustodialKeyFileSuffix in facilitator/internal/signer/custodial.go.
PEM_SUFFIX=".ed25519"

# Strip whitespace, ignore empty entries, dedupe while preserving order.
# Avoid associative arrays — macOS ships bash 3.2 by default, which lacks them.
IFS=',' read -ra RAW_PARTIES <<<"$PARTIES_INPUT"
PARTIES=()
for raw in "${RAW_PARTIES[@]}"; do
  party="${raw//[[:space:]]/}"
  [[ -z "$party" ]] && continue
  seen=0
  for existing in "${PARTIES[@]:-}"; do
    if [[ "$existing" == "$party" ]]; then
      seen=1
      break
    fi
  done
  [[ "$seen" -eq 0 ]] && PARTIES+=("$party")
done

if [[ ${#PARTIES[@]} -eq 0 ]]; then
  err "PAYER_PARTIES contained no non-empty entries"
  exit 2
fi

for party in "${PARTIES[@]}"; do
  init_party "$party"
done

note "ok (parties=${#PARTIES[@]} dir=${CUSTODIAL_KEY_DIR})"
