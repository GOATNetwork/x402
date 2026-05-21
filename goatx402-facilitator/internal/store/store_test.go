package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/goatnetwork/goatx402-receipt"
)

// ---------- helpers ----------

// newTestStore returns a fresh in-memory store. Each test gets a unique
// shared-cache name so parallel tests do not collide.
func newTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	dsn := fmt.Sprintf(
		"file:%s?mode=memory&cache=shared&_busy_timeout=5000&_foreign_keys=1",
		uuid.NewString(),
	)
	s, err := Open(SQLiteOptions{DSN: dsn, MigrateOnOpen: true})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func sampleOrder(id string) Order {
	memo := "test-memo"
	return Order{
		ID:                      id,
		Status:                  StatusCreated,
		Amount:                  "1.5",
		Currency:                "USD-canton",
		TrustedIssuer:           "issuer-party-1",
		Merchant:                "merchant-party-1",
		Payer:                   "payer-party-1",
		Resource:                "/widgets/42",
		Nonce:                   base64.StdEncoding.EncodeToString([]byte(id + "-nonce")),
		Memo:                    &memo,
		ExpiresAt:               time.Now().Add(2 * time.Minute).UnixMilli(),
		DedupID:                 base64.StdEncoding.EncodeToString([]byte(id + "-dedup")),
		PayloadHash:             []byte("payload-hash-" + id),
		MerchantRequestID:       "mreq-abcdefghijklmnopqrstuv",
		SourceHoldingContractID: "holding-cid-1",
	}
}

func sampleReceipt(orderID string) receipt.CantonReceipt {
	return receipt.CantonReceipt{
		Version:                  receipt.SchemaVersion,
		Domain:                   receipt.DomainV1,
		OrderID:                  orderID,
		LedgerID:                 "ledger-1",
		TransactionID:            "tx-" + orderID,
		ContractID:               "merchant-holding-cid",
		PaymentRequestContractID: "pr-cid",
		ParticipantPartyID:       "participant-1",
		Merchant:                 "merchant-party-1",
		Payer:                    "payer-party-1",
		Amount:                   "1.5",
		Currency:                 "USD-canton",
		TrustedIssuer:            "issuer-party-1",
		Resource:                 "/widgets/42",
		MerchantRequestID:        "mreq-abcdefghijklmnopqrstuv",
		ExpiresAtHTTP:            time.Now().Add(2 * time.Minute).UnixMilli(),
		ExpiresAtDaml:            time.Now().Add(3 * time.Minute).UnixMilli(),
		SignatureScheme:          receipt.SignatureSchemeEd25519,
		Signature:                base64.StdEncoding.EncodeToString([]byte("sig-bytes-here")),
		ReceiptPayloadHash:       base64.StdEncoding.EncodeToString([]byte("receipt-hash")),
		CompletedAt:              time.Now().UnixMilli(),
	}
}

// mustCreate writes a fresh order and returns the persisted row.
func mustCreate(t *testing.T, s *SQLiteStore, ord Order) Order {
	t.Helper()
	if err := s.Create(context.Background(), ord); err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := s.Get(context.Background(), ord.ID)
	if err != nil {
		t.Fatalf("Get after Create: %v", err)
	}
	return got
}

// receiptCount returns the number of rows in receipts for the order.
func receiptCount(t *testing.T, s *SQLiteStore, orderID string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM receipts WHERE order_id = ?;`, orderID).Scan(&n); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	return n
}

// ---------- 1. Create / Get round-trip + duplicate handling ----------

func TestCreateAndGet_RoundTrip(t *testing.T) {
	s := newTestStore(t)
	id := uuid.NewString()
	o := sampleOrder(id)
	got := mustCreate(t, s, o)

	if got.ID != id {
		t.Fatalf("id = %q, want %q", got.ID, id)
	}
	if got.Status != StatusCreated {
		t.Fatalf("status = %q, want %q", got.Status, StatusCreated)
	}
	if got.StatusVersion != 0 {
		t.Fatalf("status_version = %d, want 0", got.StatusVersion)
	}
	if got.Memo == nil || *got.Memo != "test-memo" {
		t.Fatalf("memo = %v, want %q", got.Memo, "test-memo")
	}
	if string(got.PayloadHash) != "payload-hash-"+id {
		t.Fatalf("payload_hash mismatch")
	}
}

func TestCreate_DuplicateDedup(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)

	dup := sampleOrder(uuid.NewString())
	dup.DedupID = o.DedupID // re-use → UNIQUE violation
	err := s.Create(context.Background(), dup)
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("Create(dup) error = %v, want ErrDuplicate", err)
	}
}

func TestCreate_DuplicatePayerClientRequest(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	cri := "client-req-1"
	o.ClientRequestID = &cri
	mustCreate(t, s, o)

	dup := sampleOrder(uuid.NewString())
	dup.ClientRequestID = &cri // same payer + same clientRequestId
	dup.DedupID = "different-dedup"
	err := s.Create(context.Background(), dup)
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("Create(dup payer/cri) error = %v, want ErrDuplicate", err)
	}
}

// ---------- 2. Transition matrix (table-driven, exhaustive) ----------

// TestTransitionMatrix exhaustively walks every (from, to) pair against the
// PLAN.md §4.2 matrix. Bare Transition is the API under test; the
// combinator-only edges are expected to return ErrIllegalTransition since
// callers must use TransitionAndArmRetry / SaveReceiptAndConfirm /
// MarkPaymentFailedAfterMaxRetries / RecordRetry.
func TestTransitionMatrix(t *testing.T) {
	allStates := []Status{
		StatusCreated, StatusCheckoutVerified, StatusPaymentConfirmed,
		StatusPaymentFailed, StatusCancelled, StatusExpired,
	}

	type want struct {
		inMatrix  bool // appears in PLAN §4.2 table
		bareEdge  bool // reachable via bare Transition
	}
	matrix := func(from, to Status) want {
		return want{
			inMatrix: IsAllowedTransition(from, to),
			bareEdge: IsBareTransitionAllowed(from, to),
		}
	}

	for _, from := range allStates {
		for _, to := range allStates {
			from, to := from, to
			t.Run(fmt.Sprintf("%s_to_%s", from, to), func(t *testing.T) {
				w := matrix(from, to)

				s := newTestStore(t)
				o := sampleOrder(uuid.NewString())
				mustCreate(t, s, o)

				// Park the order in `from` by invoking the right
				// combinator (bare Transition deliberately cannot
				// reach every from-state).
				placeInState(t, s, o.ID, from)
				current, err := s.Get(context.Background(), o.ID)
				if err != nil {
					t.Fatalf("Get: %v", err)
				}

				_, err = s.Transition(context.Background(), o.ID, from, to, current.StatusVersion, "matrix-test")

				if w.bareEdge {
					if err != nil {
						t.Fatalf("expected bare edge %s→%s to succeed: %v", from, to, err)
					}
					got, err := s.Get(context.Background(), o.ID)
					if err != nil {
						t.Fatalf("Get post-transition: %v", err)
					}
					if got.Status != to {
						t.Fatalf("status after bare = %q, want %q", got.Status, to)
					}
					if got.StatusVersion != current.StatusVersion+1 {
						t.Fatalf("status_version not bumped: got %d, was %d", got.StatusVersion, current.StatusVersion)
					}
					return
				}

				// Combinator-only or fully disallowed → bare must return ErrIllegalTransition.
				if !errors.Is(err, ErrIllegalTransition) {
					t.Fatalf(
						"bare Transition for %s→%s (in-matrix=%v, bare=%v): err = %v, want ErrIllegalTransition",
						from, to, w.inMatrix, w.bareEdge, err,
					)
				}
			})
		}
	}
}

// placeInState walks the order through whatever combinators are required to
// land in `target`. Used by the matrix test.
func placeInState(t *testing.T, s *SQLiteStore, orderID string, target Status) {
	t.Helper()
	ctx := context.Background()
	switch target {
	case StatusCreated:
		// Already in CREATED.
		return
	case StatusCheckoutVerified:
		cur, _ := s.Get(ctx, orderID)
		_, err := s.TransitionAndArmRetry(ctx, orderID, cur.StatusVersion, "cmd-"+orderID, time.Now().Add(time.Second))
		if err != nil {
			t.Fatalf("placeInState CHECKOUT_VERIFIED: %v", err)
		}
	case StatusPaymentConfirmed:
		placeInState(t, s, orderID, StatusCheckoutVerified)
		cur, _ := s.Get(ctx, orderID)
		_, err := s.SaveReceiptAndConfirm(ctx, orderID, sampleReceipt(orderID), cur.StatusVersion)
		if err != nil {
			t.Fatalf("placeInState PAYMENT_CONFIRMED: %v", err)
		}
	case StatusPaymentFailed:
		placeInState(t, s, orderID, StatusCheckoutVerified)
		cur, _ := s.Get(ctx, orderID)
		_, err := s.MarkPaymentFailedAfterMaxRetries(ctx, orderID, cur.StatusVersion, "max retries")
		if err != nil {
			t.Fatalf("placeInState PAYMENT_FAILED: %v", err)
		}
	case StatusCancelled:
		cur, _ := s.Get(ctx, orderID)
		_, err := s.Transition(ctx, orderID, StatusCreated, StatusCancelled, cur.StatusVersion, "cancel")
		if err != nil {
			t.Fatalf("placeInState CANCELLED: %v", err)
		}
	case StatusExpired:
		cur, _ := s.Get(ctx, orderID)
		_, err := s.Transition(ctx, orderID, StatusCreated, StatusExpired, cur.StatusVersion, "expired")
		if err != nil {
			t.Fatalf("placeInState EXPIRED: %v", err)
		}
	default:
		t.Fatalf("placeInState: unknown target %q", target)
	}
}

// ---------- 3. Concurrent CAS (race-test) ----------

// TestConcurrentTransition_ExactlyOneWinner fires N goroutines all attempting
// the same CREATED → CANCELLED transition with the same status_version.
// Exactly one MUST succeed and the rest MUST receive ErrCASFailed.
//
// Run with `go test -race` to also assert there are no data races.
func TestConcurrentTransition_ExactlyOneWinner(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)

	const goroutines = 10
	var (
		wg        sync.WaitGroup
		successes int64
		casFails  int64
		start     = make(chan struct{})
	)
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Transition(
				context.Background(),
				o.ID, StatusCreated, StatusCancelled,
				/* version */ 0,
				"concurrent",
			)
			switch {
			case err == nil:
				atomic.AddInt64(&successes, 1)
			case errors.Is(err, ErrCASFailed):
				atomic.AddInt64(&casFails, 1)
			default:
				// Use t.Errorf (not Fatal) — we are inside a goroutine.
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if successes != 1 {
		t.Fatalf("successes = %d, want 1", successes)
	}
	if casFails != goroutines-1 {
		t.Fatalf("casFails = %d, want %d", casFails, goroutines-1)
	}

	got, err := s.Get(context.Background(), o.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != StatusCancelled {
		t.Fatalf("final status = %q, want CANCELLED", got.Status)
	}
	if got.StatusVersion != 1 {
		t.Fatalf("status_version = %d, want 1 (exactly one CAS bump)", got.StatusVersion)
	}
}

// ---------- 4. TransitionAndArmRetry sets the sweeper invariant ----------

func TestTransitionAndArmRetry_ArmsSweeperFields(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)

	nextAt := time.Now().Add(2 * time.Second)
	got, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd-A", nextAt)
	if err != nil {
		t.Fatalf("TransitionAndArmRetry: %v", err)
	}
	if got.Status != StatusCheckoutVerified {
		t.Fatalf("status = %q, want CHECKOUT_VERIFIED", got.Status)
	}
	if got.CommandID == nil || *got.CommandID != "cmd-A" {
		t.Fatalf("command_id = %v, want cmd-A", got.CommandID)
	}
	if got.RetryCount != 0 {
		t.Fatalf("retry_count = %d, want 0", got.RetryCount)
	}
	if got.RetryNextAt == nil {
		t.Fatalf("retry_next_at must be set after TransitionAndArmRetry — sweeper invariant")
	}
	if *got.RetryNextAt != nextAt.UnixMilli() {
		t.Fatalf("retry_next_at = %d, want %d", *got.RetryNextAt, nextAt.UnixMilli())
	}
	if got.StatusVersion != 1 {
		t.Fatalf("status_version = %d, want 1", got.StatusVersion)
	}
}

// TestTransitionAndArmRetry_StaleVersion proves the CAS fence holds.
func TestTransitionAndArmRetry_StaleVersion(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)

	_, err := s.TransitionAndArmRetry(context.Background(), o.ID, /* wrong version */ 99, "cmd-A", time.Now())
	if !errors.Is(err, ErrCASFailed) {
		t.Fatalf("err = %v, want ErrCASFailed", err)
	}
}

// ---------- 5. SaveReceiptAndConfirm — happy path + idempotency ----------

func TestSaveReceiptAndConfirm_HappyPath(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)
	if _, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd", time.Now()); err != nil {
		t.Fatalf("arm: %v", err)
	}

	cur, _ := s.Get(context.Background(), o.ID)
	got, err := s.SaveReceiptAndConfirm(context.Background(), o.ID, sampleReceipt(o.ID), cur.StatusVersion)
	if err != nil {
		t.Fatalf("SaveReceiptAndConfirm: %v", err)
	}
	if got.Status != StatusPaymentConfirmed {
		t.Fatalf("status = %q, want PAYMENT_CONFIRMED", got.Status)
	}
	if receiptCount(t, s, o.ID) != 1 {
		t.Fatalf("expected exactly 1 receipt row")
	}
}

func TestSaveReceiptAndConfirm_StaleVersion_NoOrphan(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)
	if _, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd", time.Now()); err != nil {
		t.Fatalf("arm: %v", err)
	}

	_, err := s.SaveReceiptAndConfirm(context.Background(), o.ID, sampleReceipt(o.ID), /* wrong */ 99)
	if !errors.Is(err, ErrCASFailed) {
		t.Fatalf("err = %v, want ErrCASFailed", err)
	}
	if receiptCount(t, s, o.ID) != 0 {
		t.Fatalf("orphan receipt row created on CAS failure (atomicity violation)")
	}
	got, _ := s.Get(context.Background(), o.ID)
	if got.Status != StatusCheckoutVerified {
		t.Fatalf("status leaked to %q after failed SaveReceiptAndConfirm", got.Status)
	}
}

// ---------- 6. Kill-test: SaveReceiptAndConfirm atomicity ----------
//
// Per PLAN.md task spec: "kill-test: SIGKILL between INSERT and CAS leaves the
// order in CHECKOUT_VERIFIED with no orphan receipt row".
//
// We simulate the SIGKILL by injecting a failure via testHookBeforeCommit
// AFTER the receipt INSERT and AFTER the CAS UPDATE but BEFORE COMMIT. SQLite's
// transactional guarantee is that an aborted transaction is fully rolled back,
// which is exactly what would happen if the process were killed between
// INSERT and COMMIT. The assertion is identical: no orphan receipt, status
// remains CHECKOUT_VERIFIED. (A real SIGKILL test would require a subprocess
// harness; the SQL-tx-rollback path is the same code path SQLite executes
// at re-open time after a crash.)

func TestSaveReceiptAndConfirm_KillBeforeCommit_NoOrphan(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)
	if _, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd", time.Now()); err != nil {
		t.Fatalf("arm: %v", err)
	}
	cur, _ := s.Get(context.Background(), o.ID)

	// Inject a "kill before commit" — both the receipt INSERT and the
	// CAS UPDATE have already executed when the hook fires.
	injectedErr := errors.New("simulated SIGKILL between INSERT and COMMIT")
	s.testHookBeforeCommit = func(tx *sql.Tx) error {
		// Sanity: the in-tx view DOES contain the receipt at this point.
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM receipts WHERE order_id = ?;`, o.ID).Scan(&n); err != nil {
			t.Errorf("in-tx receipt count: %v", err)
		}
		if n != 1 {
			t.Errorf("in-tx receipt count = %d, want 1 (hook should fire after INSERT)", n)
		}
		return injectedErr
	}
	defer func() { s.testHookBeforeCommit = nil }()

	_, err := s.SaveReceiptAndConfirm(context.Background(), o.ID, sampleReceipt(o.ID), cur.StatusVersion)
	if !errors.Is(err, injectedErr) {
		t.Fatalf("err = %v, want injectedErr", err)
	}

	// External view: the rollback wiped the receipt and the status update.
	if rc := receiptCount(t, s, o.ID); rc != 0 {
		t.Fatalf("orphan receipt after simulated kill: %d rows", rc)
	}
	got, err := s.Get(context.Background(), o.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != StatusCheckoutVerified {
		t.Fatalf("status = %q after simulated kill, want CHECKOUT_VERIFIED", got.Status)
	}
	if got.StatusVersion != cur.StatusVersion {
		t.Fatalf("status_version = %d, want %d (must not have been bumped by the rolled-back tx)",
			got.StatusVersion, cur.StatusVersion)
	}
}

// ---------- 7. RecordRetry + sweeper drives PAYMENT_FAILED after exhaustion ----------

func TestRecordRetry_BumpsCountAndArmsNextAt(t *testing.T) {
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)
	if _, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd", time.Now()); err != nil {
		t.Fatalf("arm: %v", err)
	}
	cur, _ := s.Get(context.Background(), o.ID)

	nextAt := time.Now().Add(2 * time.Second)
	got, err := s.RecordRetry(context.Background(), o.ID, "DeadlineExceeded", "ctx deadline", nextAt, cur.StatusVersion)
	if err != nil {
		t.Fatalf("RecordRetry: %v", err)
	}
	if got.Status != StatusCheckoutVerified {
		t.Fatalf("status = %q, want CHECKOUT_VERIFIED (same-state retry)", got.Status)
	}
	if got.RetryCount != 1 {
		t.Fatalf("retry_count = %d, want 1", got.RetryCount)
	}
	if got.RetryLastError == nil || *got.RetryLastError == "" {
		t.Fatalf("retry_last_error must be populated")
	}
	if got.RetryNextAt == nil || *got.RetryNextAt != nextAt.UnixMilli() {
		t.Fatalf("retry_next_at = %v, want %d", got.RetryNextAt, nextAt.UnixMilli())
	}
	if got.StatusVersion != cur.StatusVersion+1 {
		t.Fatalf("status_version not bumped: got %d, was %d", got.StatusVersion, cur.StatusVersion)
	}
}

// TestSweeperDrivesPaymentFailedAfterRetryExhaustion exercises the
// retry-then-fail sequence with the sweeper helpers (ListRetryCandidates +
// MarkPaymentFailedAfterMaxRetries). After MAX_RETRIES retries the order is
// driven to PAYMENT_FAILED.
func TestSweeperDrivesPaymentFailedAfterRetryExhaustion(t *testing.T) {
	const MaxRetries = 3
	s := newTestStore(t)
	o := sampleOrder(uuid.NewString())
	mustCreate(t, s, o)
	if _, err := s.TransitionAndArmRetry(context.Background(), o.ID, 0, "cmd", time.Now().Add(-time.Second)); err != nil {
		t.Fatalf("arm: %v", err)
	}

	for i := 0; i < MaxRetries; i++ {
		// Sweeper picks the row up.
		due, err := s.ListRetryCandidates(context.Background(), time.Now(), 10)
		if err != nil {
			t.Fatalf("ListRetryCandidates: %v", err)
		}
		if len(due) != 1 || due[0].ID != o.ID {
			t.Fatalf("retry candidates = %d, want 1 with id=%s", len(due), o.ID)
		}
		if _, err := s.RecordRetry(
			context.Background(), o.ID, "DeadlineExceeded", "ctx deadline",
			time.Now().Add(-time.Millisecond), // due immediately for the next loop iter
			due[0].StatusVersion,
		); err != nil {
			t.Fatalf("RecordRetry %d: %v", i, err)
		}
	}

	cur, _ := s.Get(context.Background(), o.ID)
	if cur.RetryCount != MaxRetries {
		t.Fatalf("retry_count = %d, want %d", cur.RetryCount, MaxRetries)
	}
	got, err := s.MarkPaymentFailedAfterMaxRetries(context.Background(), o.ID, cur.StatusVersion, "max retries exhausted")
	if err != nil {
		t.Fatalf("MarkPaymentFailedAfterMaxRetries: %v", err)
	}
	if got.Status != StatusPaymentFailed {
		t.Fatalf("status = %q, want PAYMENT_FAILED", got.Status)
	}
	if got.RetryNextAt != nil {
		t.Fatalf("retry_next_at must be cleared on PAYMENT_FAILED, got %v", *got.RetryNextAt)
	}

	// And the row no longer shows up as a retry candidate.
	due, _ := s.ListRetryCandidates(context.Background(), time.Now(), 10)
	if len(due) != 0 {
		t.Fatalf("retry candidates after PAYMENT_FAILED = %d, want 0", len(due))
	}
}

// ---------- 8. ListExpiredCandidates ----------

func TestListExpiredCandidates(t *testing.T) {
	s := newTestStore(t)
	now := time.Now()

	// Past-expired CREATED.
	expired := sampleOrder(uuid.NewString())
	expired.ExpiresAt = now.Add(-time.Minute).UnixMilli()
	mustCreate(t, s, expired)

	// Past-expired CHECKOUT_VERIFIED.
	expiredCV := sampleOrder(uuid.NewString())
	expiredCV.ExpiresAt = now.Add(-2 * time.Minute).UnixMilli()
	mustCreate(t, s, expiredCV)
	if _, err := s.TransitionAndArmRetry(context.Background(), expiredCV.ID, 0, "cmd-cv", now); err != nil {
		t.Fatalf("arm: %v", err)
	}

	// Future-expiry — should NOT appear.
	future := sampleOrder(uuid.NewString())
	future.ExpiresAt = now.Add(time.Hour).UnixMilli()
	mustCreate(t, s, future)

	// Already CONFIRMED — should NOT appear.
	done := sampleOrder(uuid.NewString())
	done.ExpiresAt = now.Add(-time.Minute).UnixMilli()
	mustCreate(t, s, done)
	if _, err := s.TransitionAndArmRetry(context.Background(), done.ID, 0, "cmd-d", now); err != nil {
		t.Fatalf("arm: %v", err)
	}
	cur, _ := s.Get(context.Background(), done.ID)
	if _, err := s.SaveReceiptAndConfirm(context.Background(), done.ID, sampleReceipt(done.ID), cur.StatusVersion); err != nil {
		t.Fatalf("save receipt: %v", err)
	}

	got, err := s.ListExpiredCandidates(context.Background(), now, 100)
	if err != nil {
		t.Fatalf("ListExpiredCandidates: %v", err)
	}
	gotIDs := map[string]bool{}
	for _, o := range got {
		gotIDs[o.ID] = true
	}
	if !gotIDs[expired.ID] {
		t.Fatalf("missing CREATED expired order")
	}
	if !gotIDs[expiredCV.ID] {
		t.Fatalf("missing CHECKOUT_VERIFIED expired order")
	}
	if gotIDs[future.ID] {
		t.Fatalf("future-expiry order should not appear")
	}
	if gotIDs[done.ID] {
		t.Fatalf("PAYMENT_CONFIRMED order should not appear")
	}
}

// ---------- 9. Pure matrix-helper unit test (covers the IsAllowedTransition table) ----------

func TestIsAllowedTransition_MatchesPlanMatrix(t *testing.T) {
	type edge struct{ from, to Status }
	allowed := map[edge]bool{
		{StatusCreated, StatusCheckoutVerified}:                  true,
		{StatusCreated, StatusExpired}:                           true,
		{StatusCreated, StatusCancelled}:                         true,
		{StatusCheckoutVerified, StatusPaymentConfirmed}:         true,
		{StatusCheckoutVerified, StatusPaymentFailed}:            true,
		{StatusCheckoutVerified, StatusCheckoutVerified}:         true,
		{StatusCheckoutVerified, StatusExpired}:                  true,
	}
	allStates := []Status{
		StatusCreated, StatusCheckoutVerified, StatusPaymentConfirmed,
		StatusPaymentFailed, StatusCancelled, StatusExpired,
	}
	for _, from := range allStates {
		for _, to := range allStates {
			want := allowed[edge{from, to}]
			if got := IsAllowedTransition(from, to); got != want {
				t.Errorf("IsAllowedTransition(%s, %s) = %v, want %v", from, to, got, want)
			}
		}
	}
}
