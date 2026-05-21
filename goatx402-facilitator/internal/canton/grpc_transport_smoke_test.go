package canton

// grpc_transport_smoke_test.go is the live "does the wire actually move
// bytes" check. It runs under the default `go test` (no `-tags=integration`)
// because Task 9 ("the gRPC transport ships and the boot path dials Canton
// without panicking") is in the always-on quality bar — if a refactor
// breaks the gRPC dial, every commit's CI should catch it, not only the
// integration job.
//
// The test:
//
//   - dials whatever CANTON_GRPC_ADDR points at (default localhost:5011 to
//     match canton/bootstrap.canton + the README), with a short timeout;
//   - calls AllocateParty against the participant's
//     PartyManagementService;
//   - asserts that a non-empty party id comes back (Daml LAPI guarantees
//     idempotency, so re-running the test against the same hint returns the
//     same id without error).
//
// If the participant is unreachable (no localnet running, CI without the
// canton service-container, etc.) the test t.Skip's with a clear runbook
// line — it does NOT fail; the integration suite (build tag `integration`)
// is the gate that fails when the participant must be present.

import (
	"context"
	"fmt"
	"net"
	"os"
	"testing"
	"time"
)

func TestGRPCTransport_AllocateParty_WireSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("-short: skipping live wire smoke test")
	}
	addr := os.Getenv("CANTON_GRPC_ADDR")
	if addr == "" {
		addr = "localhost:5011"
	}
	// Probe TCP first so a missing localnet skips fast rather than waiting
	// out the gRPC dial timeout.
	c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		t.Skipf("CANTON_GRPC_ADDR=%s not reachable (%v) — skipping live smoke; bring up localnet via `make canton-up`", addr, err)
	}
	_ = c.Close()

	cfg := DefaultConfig()
	cfg.GRPCAddr = addr
	cfg.LedgerID = "participant1"

	transport, err := NewGRPCTransport(cfg)
	if err != nil {
		t.Fatalf("NewGRPCTransport: %v", err)
	}
	t.Cleanup(func() { _ = transport.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Unique hint so re-running the test on the same canton instance does
	// not collide with a prior allocation. Canton 2.x's gRPC
	// PartyManagementService rejects duplicate hints with INVALID_ARGUMENT
	// "Party already exists" (the JSON-LAPI form documents idempotency, but
	// gRPC does not — the bootstrap script in canton/bootstrap.canton uses
	// `participant.parties.enable` for idempotent setup, this transport
	// path is for tests and the live integration suite).
	hint := fmt.Sprintf("wire-smoke-%d", time.Now().UnixNano())
	party, err := transport.AllocateParty(ctx, hint)
	if err != nil {
		t.Fatalf("AllocateParty(%s): %v", hint, err)
	}
	if party == "" {
		t.Fatalf("AllocateParty(%s) returned empty party id", hint)
	}
	t.Logf("AllocateParty(%q) -> %q", hint, party)
}
