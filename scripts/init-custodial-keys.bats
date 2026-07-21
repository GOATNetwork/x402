#!/usr/bin/env bats
#
# bats tests for scripts/init-custodial-keys.sh — fresh-init + idempotent
# re-run (PLAN.md Task 6 acceptance).

setup() {
  SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" >/dev/null 2>&1 && pwd)"
  SCRIPT="${SCRIPT_DIR}/init-custodial-keys.sh"
  WORK="$(mktemp -d -t goat-init-XXXXXX)"
  export CUSTODIAL_KEY_DIR="${WORK}/keys"
  export PAYER_KEY_REGISTRY_PATH="${WORK}/registry.json"
  export PAYER_TOKEN_FILE="${WORK}/tokens.json"
  export PAYER_PARTIES="alice,bob"
}

teardown() {
  if [[ -n "${WORK:-}" && -d "$WORK" ]]; then
    rm -rf "$WORK"
  fi
  unset CUSTODIAL_KEY_DIR PAYER_KEY_REGISTRY_PATH PAYER_TOKEN_FILE PAYER_PARTIES
}

require_jq_openssl() {
  command -v jq >/dev/null 2>&1 || skip "jq not installed"
  command -v openssl >/dev/null 2>&1 || skip "openssl not installed"
}

@test "fresh init: creates one PEM key per party, populates registry and tokens" {
  require_jq_openssl
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]

  [ -f "${CUSTODIAL_KEY_DIR}/alice.ed25519" ]
  [ -f "${CUSTODIAL_KEY_DIR}/bob.ed25519" ]

  # PKCS#8 PEM marker check.
  grep -q "BEGIN PRIVATE KEY" "${CUSTODIAL_KEY_DIR}/alice.ed25519"
  grep -q "BEGIN PRIVATE KEY" "${CUSTODIAL_KEY_DIR}/bob.ed25519"

  run jq -r 'keys | sort | join(",")' "$PAYER_KEY_REGISTRY_PATH"
  [ "$status" -eq 0 ]
  [ "$output" = "alice,bob" ]

  run jq -r 'keys | sort | join(",")' "$PAYER_TOKEN_FILE"
  [ "$status" -eq 0 ]
  [ "$output" = "alice,bob" ]

  # Pubkey is base64 raw 32 bytes => 44 chars including '=' padding.
  run jq -r '.alice' "$PAYER_KEY_REGISTRY_PATH"
  [ "${#output}" -eq 44 ]
  run jq -r '.alice' "$PAYER_TOKEN_FILE"
  [ "${#output}" -eq 44 ]
}

@test "idempotent re-run: re-invocation is a no-op (no rotation, no churn)" {
  require_jq_openssl
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]

  # Snapshot first-run artefacts.
  alice_priv="$(cat "${CUSTODIAL_KEY_DIR}/alice.ed25519")"
  bob_priv="$(cat "${CUSTODIAL_KEY_DIR}/bob.ed25519")"
  reg_before="$(cat "$PAYER_KEY_REGISTRY_PATH")"
  tok_before="$(cat "$PAYER_TOKEN_FILE")"

  # Re-run with the same PAYER_PARTIES — must not regenerate keys, must not
  # rotate tokens, must not modify the registry entries.
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]

  [ "$(cat "${CUSTODIAL_KEY_DIR}/alice.ed25519")" = "$alice_priv" ]
  [ "$(cat "${CUSTODIAL_KEY_DIR}/bob.ed25519")" = "$bob_priv" ]
  [ "$(cat "$PAYER_KEY_REGISTRY_PATH")" = "$reg_before" ]
  [ "$(cat "$PAYER_TOKEN_FILE")" = "$tok_before" ]
}

@test "additive: a second party added on re-run is appended, others untouched" {
  require_jq_openssl
  PAYER_PARTIES="alice"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]

  alice_priv="$(cat "${CUSTODIAL_KEY_DIR}/alice.ed25519")"
  alice_token="$(jq -r '.alice' "$PAYER_TOKEN_FILE")"

  PAYER_PARTIES="alice,carol" run bash "$SCRIPT"
  [ "$status" -eq 0 ]

  # alice unchanged.
  [ "$(cat "${CUSTODIAL_KEY_DIR}/alice.ed25519")" = "$alice_priv" ]
  [ "$(jq -r '.alice' "$PAYER_TOKEN_FILE")" = "$alice_token" ]
  # carol added.
  [ -f "${CUSTODIAL_KEY_DIR}/carol.ed25519" ]
  run jq -r 'keys | sort | join(",")' "$PAYER_KEY_REGISTRY_PATH"
  [ "$output" = "alice,carol" ]
}

@test "argv form: positional args work when PAYER_PARTIES is unset" {
  require_jq_openssl
  unset PAYER_PARTIES
  run bash "$SCRIPT" alice bob
  [ "$status" -eq 0 ]
  run jq -r 'keys | sort | join(",")' "$PAYER_KEY_REGISTRY_PATH"
  [ "$output" = "alice,bob" ]
}

@test "rejects both env and argv set at once" {
  require_jq_openssl
  run bash "$SCRIPT" carol
  [ "$status" -ne 0 ]
}

@test "rejects missing PAYER_PARTIES entirely" {
  require_jq_openssl
  unset PAYER_PARTIES
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "rejects when required env paths are unset" {
  require_jq_openssl
  unset PAYER_KEY_REGISTRY_PATH
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "private key files are chmod 600" {
  require_jq_openssl
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # Portable mode check (BSD vs GNU stat differs).
  perm="$(ls -l "${CUSTODIAL_KEY_DIR}/alice.ed25519" | awk '{print $1}')"
  [ "$perm" = "-rw-------" ]
}
