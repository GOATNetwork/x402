#!/usr/bin/env bash
# canton-down.sh — stop and remove the Canton localnet container.
#
# Idempotent. Does NOT remove docker volumes or state/.

set -euo pipefail

CANTON_CONTAINER="${CANTON_CONTAINER:-canton-localnet-goatx402}"

err()  { printf 'canton-down: %s\n' "$*" >&2; }
note() { printf 'canton-down: %s\n' "$*" >&2; }

if ! command -v docker >/dev/null 2>&1; then
  err "docker not on PATH"
  exit 2
fi

if docker ps -a --format '{{.Names}}' | grep -q "^${CANTON_CONTAINER}\$"; then
  note "stopping + removing ${CANTON_CONTAINER}"
  docker rm -f "$CANTON_CONTAINER" >/dev/null 2>&1 || true
else
  note "no ${CANTON_CONTAINER} container present"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rm -f "$REPO_ROOT/state/canton.pid" "$REPO_ROOT/logs/canton.log.docker-id"
