#!/usr/bin/env bash
# canton-up.sh — bring up a Canton localnet for the goatx402 canton port.
#
# Self-contained: no lib.sh dependency, no SDK-vs-docker auto-detection.
# Standardises on the docker mode; the SDK path is documented but not
# wired here because the docker-compose-up-d goal (see PLAN §9 of the
# port-plan) prefers a single bring-up mechanism.
#
# Idempotent: re-running on an already-up canton container is a no-op.
#
# Env knobs:
#   CANTON_IMAGE       default digitalasset/canton-open-source@sha256:98068c06... (pinned)
#   CANTON_CONTAINER   default canton-localnet-goatx402
#   CANTON_PORT        default 5011 (ledger api)
#   CANTON_ADMIN_PORT  default 5012 (admin api)
#   CANTON_DOMAIN_PORT default 5018 (domain public)
#   CANTON_DOMAIN_ADMIN default 5019 (domain admin)
#   CANTON_READY_TIMEOUT default 120 (seconds — docker JVM boot needs ~30s)

set -euo pipefail

err()  { printf 'canton-up: %s\n' "$*" >&2; }
note() { printf 'canton-up: %s\n' "$*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANTON_DIR="$REPO_ROOT/goatx402-canton"
LOGS_DIR="$REPO_ROOT/logs"
STATE_DIR="$REPO_ROOT/state"
mkdir -p "$LOGS_DIR" "$STATE_DIR"

# Image digest pinned per docs/canton/preflight-notes.md.
CANTON_IMAGE="${CANTON_IMAGE:-digitalasset/canton-open-source@sha256:98068c061913cdfaa3898b480a2c0a343b59144d3942678a4929cadb51e5f52a}"
CANTON_CONTAINER="${CANTON_CONTAINER:-canton-localnet-goatx402}"
#   Defaults shifted to the 5030 range so a dev machine can run this branch's
#   localnet alongside other canton containers (e.g. the existing goat-canton-payment
#   dev env which uses 5011-5019). Override env vars to reuse 5011 if desired.
CANTON_PORT="${CANTON_PORT:-5031}"
CANTON_ADMIN_PORT="${CANTON_ADMIN_PORT:-5032}"
CANTON_DOMAIN_PORT="${CANTON_DOMAIN_PORT:-5038}"
CANTON_DOMAIN_ADMIN="${CANTON_DOMAIN_ADMIN:-5039}"
CANTON_READY_TIMEOUT="${CANTON_READY_TIMEOUT:-120}"

PID_FILE="$STATE_DIR/canton.pid"
LOG_FILE="$LOGS_DIR/canton.log"
READY_MARKER='=== goatx402 canton localnet ready ==='

# ---------------------------------------------------------------------------
# Already running?
# ---------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -q "^${CANTON_CONTAINER}\$"; then
  note "container ${CANTON_CONTAINER} already running"
  exit 0
fi
if (echo > "/dev/tcp/127.0.0.1/${CANTON_PORT}") >/dev/null 2>&1; then
  note "port ${CANTON_PORT} already serving — assuming external canton is up"
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight.
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "docker not on PATH"
  exit 2
fi

[[ -f "$CANTON_DIR/bootstrap.canton" ]] || { err "missing $CANTON_DIR/bootstrap.canton"; exit 2; }
[[ -f "$CANTON_DIR/simple-topology.conf" ]] || { err "missing $CANTON_DIR/simple-topology.conf"; exit 2; }

# ---------------------------------------------------------------------------
# Clean up any stale stopped container.
# ---------------------------------------------------------------------------
if docker ps -a --format '{{.Names}}' | grep -q "^${CANTON_CONTAINER}\$"; then
  note "removing stale stopped container ${CANTON_CONTAINER}"
  docker rm -f "$CANTON_CONTAINER" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Start.
# ---------------------------------------------------------------------------
note "starting canton container ${CANTON_CONTAINER} (image ${CANTON_IMAGE%@*}@<digest>)"
docker run -d \
  --name "$CANTON_CONTAINER" \
  -p "${CANTON_PORT}:5011" \
  -p "${CANTON_ADMIN_PORT}:5012" \
  -p "${CANTON_DOMAIN_PORT}:5018" \
  -p "${CANTON_DOMAIN_ADMIN}:5019" \
  -v "$CANTON_DIR:/workspace/canton" \
  "$CANTON_IMAGE" \
  daemon \
    -c /workspace/canton/simple-topology.conf \
    --bootstrap /workspace/canton/bootstrap.canton \
  > "$LOG_FILE.docker-id" 2>&1
echo "$CANTON_CONTAINER" > "$PID_FILE"

# ---------------------------------------------------------------------------
# Wait for readiness: TCP listening + bootstrap marker in logs.
# ---------------------------------------------------------------------------
note "waiting up to ${CANTON_READY_TIMEOUT}s for canton to become ready"
deadline=$(( $(date +%s) + CANTON_READY_TIMEOUT ))
while (( $(date +%s) < deadline )); do
  if (echo > "/dev/tcp/127.0.0.1/${CANTON_PORT}") >/dev/null 2>&1; then
    # TCP up; now check the marker in container logs.
    if docker logs "$CANTON_CONTAINER" 2>&1 | grep -q "$READY_MARKER"; then
      note "canton ready: tcp=${CANTON_PORT} + bootstrap marker present"
      exit 0
    fi
  fi
  sleep 2
done

err "canton did not become ready within ${CANTON_READY_TIMEOUT}s"
err "last 50 lines of canton container logs:"
docker logs --tail 50 "$CANTON_CONTAINER" >&2 || true
exit 3
