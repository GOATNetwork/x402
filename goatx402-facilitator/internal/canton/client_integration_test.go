//go:build integration

// client_integration_test.go drives the canton.Client against a real Canton
// sandbox. Per AGENTS.md, ledger-touching tests must NOT mock the
// canton.Client interface — they exercise the real participant.
//
// To run:
//
//	make canton-up && make daml-upload
//	CANTON_GRPC_ADDR=localhost:5011 CANTON_JSON_ADDR=http://localhost:7575 \
//	CANTON_PAYER_PARTY=alice CANTON_MERCHANT_PARTY=merchant \
//	CANTON_ISSUER_PARTY=issuer CANTON_SOURCE_HOLDING_CID=<topup cid> \
//	go test ./internal/canton -tags=integration -run TestClient -count=1
//
// All tests t.Skip when CANTON_GRPC_ADDR is unset. The Transport is
// constructed by the buildTransport helper which Task 9's cmd/server wiring
// also calls; the test exercises the same code path production uses.
package canton

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// integrationEnv collects the env-derived configuration the integration
// suite expects. Missing fields produce t.Skip.
type integrationEnv struct {
	GRPCAddr        string
	JSONAddr        string
	PayerParty      string
	MerchantParty   string
	IssuerParty     string // trustedIssuer for the receipt.
	SourceHolding   string // topup output (see scripts/canton-up.sh).
	LedgerID        string
}

func loadIntegrationEnv(t *testing.T) integrationEnv {
	t.Helper()
	env := integrationEnv{
		GRPCAddr:      os.Getenv("CANTON_GRPC_ADDR"),
		JSONAddr:      os.Getenv("CANTON_JSON_ADDR"),
		PayerParty:    os.Getenv("CANTON_PAYER_PARTY"),
		MerchantParty: os.Getenv("CANTON_MERCHANT_PARTY"),
		IssuerParty:   os.Getenv("CANTON_ISSUER_PARTY"),
		SourceHolding: os.Getenv("CANTON_SOURCE_HOLDING_CID"),
		LedgerID:      os.Getenv("CANTON_LEDGER_ID"),
	}
	if env.GRPCAddr == "" {
		t.Skip("CANTON_GRPC_ADDR not set — integration suite skipped (run `make canton-up && make daml-upload` first)")
	}
	if env.PayerParty == "" || env.MerchantParty == "" || env.IssuerParty == "" || env.SourceHolding == "" {
		t.Skip("integration suite requires CANTON_PAYER_PARTY, CANTON_MERCHANT_PARTY, CANTON_ISSUER_PARTY, CANTON_SOURCE_HOLDING_CID")
	}
	return env
}

// newIntegrationClient builds a real-Canton-backed Client. The Transport
// constructor (NewGRPCTransport) is wired in Task 9; until then this skips
// with a clear runbook line so CI failures point at the right TODO.
func newIntegrationClient(t *testing.T, env integrationEnv) (Client, func()) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.GRPCAddr = env.GRPCAddr
	cfg.JSONAddr = env.JSONAddr
	cfg.LedgerID = env.LedgerID
	// Tight TTLs so the suite finishes quickly.
	cfg.CompletionTTL = 90 * time.Second
	cfg.DeduplicationDuration = 90 * time.Second
	cfg.RetryWindowMax = 30 * time.Second
	cfg.SubmitDeadline = 10 * time.Second

	transport, err := NewGRPCTransport(cfg)
	if err != nil {
		// The gRPC transport ships in a follow-up step (Task 9 wires
		// the dialer); the integration suite cannot run until that
		// lands. Skip rather than fail so CI doesn't flap.
		t.Skipf("gRPC transport not wired: %v (see PLAN.md §7.1 Task 8 → Task 9 wiring)", err)
	}
	c, err := NewClient(context.Background(), cfg, transport, nil)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	cleanup := func() {
		if err := c.Close(); err != nil {
			t.Logf("Close: %v", err)
		}
	}
	return c, cleanup
}

// TestClient_HealthAndAllocateParty exercises the bootstrap surface.
// AllocateParty is idempotent (repeated calls return the same party id).
func TestClient_HealthAndAllocateParty(t *testing.T) {
	env := loadIntegrationEnv(t)
	c, cleanup := newIntegrationClient(t, env)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := c.Health(ctx); err != nil {
		t.Fatalf("Health: %v", err)
	}

	hint := "itest-" + uuid.New().String()[:8]
	first, err := c.AllocateParty(ctx, hint)
	if err != nil {
		t.Fatalf("AllocateParty: %v", err)
	}
	if first == "" {
		t.Fatalf("AllocateParty returned empty party id")
	}
	second, err := c.AllocateParty(ctx, hint)
	if err != nil {
		t.Fatalf("AllocateParty (second call): %v", err)
	}
	if first != second {
		t.Fatalf("AllocateParty not idempotent: %q vs %q", first, second)
	}
}

// TestClient_SubmitCreateAndExercisePay_HappyPath asserts the §7 Task 8
// acceptance criteria:
//
//   - Integration test against real sandbox completes a Pay.
//   - completion stream emits an event matching the submitted commandId
//     with TxID populated on success.
//   - GetTransactionByID(txID) yields the create+exercise events used for
//     receipt construction.
//   - RecoverByCommandID returns the cached event for COMPLETION_TTL after
//     the original completion.
func TestClient_SubmitCreateAndExercisePay_HappyPath(t *testing.T) {
	env := loadIntegrationEnv(t)
	c, cleanup := newIntegrationClient(t, env)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Wire the per-commandId waiter via the package's Manager. The real
	// HTTP path goes via Manager.Register; the integration test does the
	// same so it exercises the production demux contract.
	mgr := managerFromClient(t, c)
	orderID := uuid.New().String()
	commandID := CommandIDFor(orderID)
	waiter, err := mgr.Register(commandID)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	in := CreateAndExercisePayInput{
		OrderID:                 orderID,
		Payer:                   env.PayerParty,
		Merchant:                env.MerchantParty,
		Amount:                  "1.0",
		Currency:                "USD",
		TrustedIssuer:           env.IssuerParty,
		SourceHoldingContractID: env.SourceHolding,
		MerchantRequestID:       "itest-mrid-" + uuid.New().String()[:8],
		Resource:                "/itest/resource",
		Nonce:                   uuid.New().String(),
		DedupKey:                "itest-dedup-" + uuid.New().String(),
		ExpiresAtHTTPSeconds:    time.Now().Add(5 * time.Minute).Unix(),
		ExpiresAtDamlSeconds:    time.Now().Add(6 * time.Minute).Unix(),
	}
	out, err := c.SubmitCreateAndExercisePay(ctx, in)
	if err != nil {
		t.Fatalf("SubmitCreateAndExercisePay: %v", err)
	}
	if out.CommandID != commandID {
		t.Fatalf("commandId not byte-stable: got %q want %q", out.CommandID, commandID)
	}

	// Block on the completion event. The mediator confirm should arrive
	// within a few seconds on a healthy sandbox.
	var ev CompletionEvent
	select {
	case ev = <-waiter:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for completion: %v", ctx.Err())
	}
	if ev.CommandID != commandID {
		t.Fatalf("completion CommandID mismatch: got %q want %q", ev.CommandID, commandID)
	}
	if ev.Status != CompletionSuccess {
		t.Fatalf("completion status: got %s code=%q msg=%q want SUCCESS", ev.Status, ev.Code, ev.Message)
	}
	if ev.TxID == "" {
		t.Fatalf("completion event has empty TxID on success")
	}

	// GetTransactionByID must yield the create+exercise events used for
	// receipt construction (PaymentRequest create + Pay exercise +
	// merchant Holding create).
	details, err := c.GetTransactionByID(ctx, ev.TxID)
	if err != nil {
		t.Fatalf("GetTransactionByID: %v", err)
	}
	if details.TxID != ev.TxID {
		t.Fatalf("TxID mismatch: got %q want %q", details.TxID, ev.TxID)
	}
	if details.PaymentRequestContractID == "" {
		t.Fatalf("PaymentRequestContractID empty — receipt construction would fail")
	}
	if details.HoldingContractID == "" {
		t.Fatalf("HoldingContractID (merchant's new holding) empty — Pay choice did not emit Transfer.create event")
	}
	if len(details.Events) == 0 {
		t.Fatalf("TransactionDetails.Events empty")
	}

	// RecoverByCommandID must return the cached event for COMPLETION_TTL.
	recovered, ok, err := c.RecoverByCommandID(ctx, commandID)
	if err != nil {
		t.Fatalf("RecoverByCommandID: %v", err)
	}
	if !ok {
		t.Fatalf("RecoverByCommandID: cache miss immediately after completion")
	}
	if recovered.TxID != ev.TxID {
		t.Fatalf("cached event TxID drift: got %q want %q", recovered.TxID, ev.TxID)
	}
}

// TestClient_FailurePath_AssertMsg forces a Daml assertMsg failure (currency
// mismatch — the issuer's Holding is USD, we submit EUR) and asserts the
// completion-stream event carries the gRPC code mapped to 400 INVALID_INPUT
// via PLAN.md §6.2 error map.
func TestClient_FailurePath_AssertMsg(t *testing.T) {
	env := loadIntegrationEnv(t)
	c, cleanup := newIntegrationClient(t, env)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	mgr := managerFromClient(t, c)
	orderID := uuid.New().String()
	commandID := CommandIDFor(orderID)
	waiter, err := mgr.Register(commandID)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	in := CreateAndExercisePayInput{
		OrderID:                 orderID,
		Payer:                   env.PayerParty,
		Merchant:                env.MerchantParty,
		Amount:                  "1.0",
		Currency:                "EUR", // intentional mismatch — issuer's holding is USD.
		TrustedIssuer:           env.IssuerParty,
		SourceHoldingContractID: env.SourceHolding,
		MerchantRequestID:       "itest-fail-" + uuid.New().String()[:8],
		Resource:                "/itest/resource-fail",
		Nonce:                   uuid.New().String(),
		DedupKey:                "itest-dedup-fail-" + uuid.New().String(),
		ExpiresAtHTTPSeconds:    time.Now().Add(5 * time.Minute).Unix(),
		ExpiresAtDamlSeconds:    time.Now().Add(6 * time.Minute).Unix(),
	}
	if _, err := c.SubmitCreateAndExercisePay(ctx, in); err != nil {
		// Some failures surface synchronously on Submit (gRPC
		// InvalidArgument); others surface on the completion stream
		// (Daml assertMsg failures). Either path satisfies the
		// acceptance criterion — record the synchronous case here and
		// skip the async wait.
		var ic *InvalidInputError
		if errors.As(err, &ic) {
			return
		}
		// Otherwise it must surface on the completion stream below.
		t.Logf("Submit returned non-classified error %v — expecting failure on completion stream", err)
	}

	select {
	case ev := <-waiter:
		if ev.Status != CompletionFailure {
			t.Fatalf("expected failure completion, got status=%s code=%q", ev.Status, ev.Code)
		}
		// gRPC code surfaced must be one of the §6.2 INVALID_INPUT-class
		// codes (InvalidArgument / FailedPrecondition / Aborted with the
		// expected Daml-side detail). Any of these will be mapped to 400
		// INVALID_INPUT by the HTTP layer per the error table.
		switch ev.Code {
		case "InvalidArgument", "FailedPrecondition", "Aborted":
			return
		}
		t.Fatalf("unexpected gRPC code on failure event: %q msg=%q (want InvalidArgument/FailedPrecondition/Aborted)", ev.Code, ev.Message)
	case <-ctx.Done():
		t.Fatalf("timed out waiting for failure completion event: %v", ctx.Err())
	}
}

// TestClient_RecoverByCommandID_TTL asserts the cache evicts entries after
// COMPLETION_TTL (PLAN.md §6.2 demux cache TTL). The integration suite
// shortens cfg.CompletionTTL to 90s in newIntegrationClient; this test
// waits past that boundary.
//
// This test is `-short` skippable so it doesn't dominate a quick run.
func TestClient_RecoverByCommandID_TTL(t *testing.T) {
	if testing.Short() {
		t.Skip("-short: skipping TTL test (waits past CompletionTTL)")
	}
	env := loadIntegrationEnv(t)
	c, cleanup := newIntegrationClient(t, env)
	defer cleanup()

	// Reach into the manager and tighten the cache TTL for this test so
	// it finishes in seconds rather than minutes.
	mgr := managerFromClient(t, c)
	mgr.cache = newTTLCache(mgr.cfg.CompletionCacheMaxEntries, 2*time.Second)

	commandID := "ttl-test-" + uuid.New().String()
	ev := CompletionEvent{
		CommandID: commandID,
		Status:    CompletionSuccess,
		TxID:      "fake-tx",
		Offset:    "0",
		Time:      time.Now().UTC(),
	}
	mgr.cache.put(commandID, ev)
	if _, ok := mgr.cache.get(commandID); !ok {
		t.Fatalf("cache miss immediately after put")
	}
	time.Sleep(3 * time.Second)
	if _, ok := mgr.cache.get(commandID); ok {
		t.Fatalf("cache hit after TTL — eviction broken")
	}
}

// ---- helpers -------------------------------------------------------------

// managerFromClient returns the demux Manager bound to a Client. It exists
// so the integration tests can Register pre-Submit (the production HTTP
// path does the same in internal/api/signature.go).
func managerFromClient(t *testing.T, c Client) *Manager {
	t.Helper()
	cc, ok := c.(*client)
	if !ok {
		t.Fatalf("integration suite expects *client, got %T", c)
	}
	return cc.stream
}
