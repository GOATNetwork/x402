// Package store owns the facilitator's order state machine and its persistence.
//
// The interface is defined per PLAN.md §6.5; the SQLite implementation lives
// in sqlite.go. All transitions are CAS on (status, status_version) and every
// transition writes one row to order_events inside the same SQL transaction.
//
// Two transitions that are NOT exposed via the bare Transition method:
//
//   - CREATED → CHECKOUT_VERIFIED — the only entry point is
//     TransitionAndArmRetry, which sets command_id, retry_count=0, and
//     retry_next_at in the same SQL transaction (PLAN.md §6.5 sweeper
//     invariant). Bare Transition for this edge would leave the order in
//     CHECKOUT_VERIFIED with retry_next_at IS NULL — invisible to the
//     sweeper — and is therefore ErrIllegalTransition.
//
//   - CHECKOUT_VERIFIED → PAYMENT_CONFIRMED — the only entry point is
//     SaveReceiptAndConfirm, which INSERTs the receipt, appends the
//     order_event, and runs the CAS-transition in a single SQL transaction
//     (PLAN.md cross-review P0 fix: there must be no window where receipt
//     and status disagree). Bare Transition for this edge is ErrIllegalTransition.
//
// CHECKOUT_VERIFIED → PAYMENT_FAILED is exposed as MarkPaymentFailedAfterMaxRetries
// (sweeper helper), and the same-state CHECKOUT_VERIFIED → CHECKOUT_VERIFIED
// retry edge is exposed as RecordRetry. Bare Transition rejects both.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/goatnetwork/goatx402-receipt"
)

// Status is the order's lifecycle state. The string values are the on-wire
// (and on-disk) form documented in PLAN.md §4.2.
type Status string

const (
	StatusCreated          Status = "CREATED"
	StatusCheckoutVerified Status = "CHECKOUT_VERIFIED"
	StatusPaymentConfirmed Status = "PAYMENT_CONFIRMED"
	StatusPaymentFailed    Status = "PAYMENT_FAILED"
	StatusCancelled        Status = "CANCELLED"
	StatusExpired          Status = "EXPIRED"
)

// Order mirrors the orders table (PLAN.md §4.2). Nullable columns use
// pointers so a zero value is distinguishable from SQL NULL.
type Order struct {
	ID                      string
	Status                  Status
	Amount                  string
	Currency                string
	TrustedIssuer           string
	Merchant                string
	Payer                   string
	Resource                string
	Nonce                   string
	Memo                    *string
	ExpiresAt               int64
	DedupID                 string
	PayloadHash             []byte
	MerchantRequestID       string
	ClientRequestID         *string
	RequestFingerprint      []byte
	SourceHoldingContractID string
	CommandID               *string
	RetryCount              int64
	RetryLastError          *string
	RetryNextAt             *int64
	CreatedAt               int64
	UpdatedAt               int64
	StatusVersion           int64
}

// OrderStore is the persistence boundary for the facilitator. The interface
// shape is taken verbatim from PLAN.md §6.5 with the additions documented in
// the file-level comment above.
type OrderStore interface {
	// Create inserts a new order in CREATED state. Returns ErrDuplicate if
	// dedup_id collides or (payer, client_request_id) already exists.
	Create(ctx context.Context, order Order) error

	// Get loads an order by id; ErrNotFound when missing.
	Get(ctx context.Context, id string) (Order, error)

	// Transition runs a CAS-transition to one of the bare-allowed edges
	// (see file-level comment for the edges that require combinators).
	// Disallowed edges return ErrIllegalTransition; CAS misses (stale
	// from/version) return ErrCASFailed.
	Transition(
		ctx context.Context,
		id string,
		from Status, to Status,
		version int64,
		reason string,
	) (Order, error)

	// TransitionAndArmRetry is the only entry point for the first
	// CREATED → CHECKOUT_VERIFIED transition. command_id, retry_count=0,
	// and retry_next_at=initialNextAt are written in the same SQL
	// transaction so the sweeper invariant cannot be violated mid-flight.
	TransitionAndArmRetry(
		ctx context.Context,
		id string,
		fromVersion int64,
		commandID string,
		initialNextAt time.Time,
	) (Order, error)

	// SaveReceiptAndConfirm INSERTs the receipt, appends an order_event,
	// and CAS-transitions CHECKOUT_VERIFIED → PAYMENT_CONFIRMED in a
	// single SQL transaction. A crash anywhere inside the call leaves
	// the order in CHECKOUT_VERIFIED with no orphan receipt row.
	SaveReceiptAndConfirm(
		ctx context.Context,
		orderID string,
		receipt receipt.CantonReceipt,
		fromVersion int64,
	) (Order, error)

	// RecordRetry is the same-state CHECKOUT_VERIFIED → CHECKOUT_VERIFIED
	// CAS-bump driven by a LEDGER_TIMEOUT or transient gRPC failure. It
	// increments retry_count, writes retry_last_error, and arms
	// retry_next_at — all in the same SQL transaction.
	RecordRetry(
		ctx context.Context,
		orderID string,
		gRPCCode string,
		errMsg string,
		nextAt time.Time,
		fromVersion int64,
	) (Order, error)

	// MarkPaymentFailedAfterMaxRetries is the sweeper helper for the
	// CHECKOUT_VERIFIED → PAYMENT_FAILED edge. It is the only documented
	// entry point for that transition; bare Transition rejects it.
	MarkPaymentFailedAfterMaxRetries(
		ctx context.Context,
		orderID string,
		fromVersion int64,
		reason string,
	) (Order, error)

	// ListExpiredCandidates returns up to `limit` rows where
	// expires_at <= asOf and status ∈ {CREATED, CHECKOUT_VERIFIED}.
	ListExpiredCandidates(ctx context.Context, asOf time.Time, limit int) ([]Order, error)

	// ListRetryCandidates returns up to `limit` rows where
	// retry_next_at <= asOf and status = CHECKOUT_VERIFIED. Backed by
	// the partial index idx_orders_retry_next_at.
	ListRetryCandidates(ctx context.Context, asOf time.Time, limit int) ([]Order, error)

	// Close releases resources. Safe to call multiple times.
	Close() error
}

// Sentinel errors. Callers compare with errors.Is.
var (
	// ErrNotFound — no row matches the supplied id.
	ErrNotFound = errors.New("store: order not found")

	// ErrDuplicate — UNIQUE constraint violated on Create (dedup_id or
	// (payer, client_request_id)).
	ErrDuplicate = errors.New("store: duplicate order")

	// ErrCASFailed — the (from, version) tuple no longer matches the row
	// (concurrent writer, retry race, or stale read). Caller should
	// re-read and decide.
	ErrCASFailed = errors.New("store: CAS failed")

	// ErrIllegalTransition — (from, to) is not in the §4.2 transition
	// matrix, OR the edge is reachable only via a combinator
	// (TransitionAndArmRetry / SaveReceiptAndConfirm /
	// MarkPaymentFailedAfterMaxRetries / RecordRetry).
	ErrIllegalTransition = errors.New("store: illegal transition")

	// ErrInvalidStatus — supplied Status string is not in the enum.
	ErrInvalidStatus = errors.New("store: invalid status")
)

// IsValidStatus reports whether s is one of the six documented states.
func IsValidStatus(s Status) bool {
	switch s {
	case StatusCreated,
		StatusCheckoutVerified,
		StatusPaymentConfirmed,
		StatusPaymentFailed,
		StatusCancelled,
		StatusExpired:
		return true
	}
	return false
}

// IsAllowedTransition reports whether (from, to) appears in the PLAN.md §4.2
// transition matrix. It is the source of truth consumed by the table-driven
// transition_matrix test and by Transition / combinator validators.
//
// NOTE: this answers "is the edge in the matrix?" — it does NOT answer "is
// the edge reachable via the bare Transition method?". For the latter, see
// IsBareTransitionAllowed.
func IsAllowedTransition(from, to Status) bool {
	switch from {
	case StatusCreated:
		switch to {
		case StatusCheckoutVerified, StatusExpired, StatusCancelled:
			return true
		}
	case StatusCheckoutVerified:
		switch to {
		case StatusPaymentConfirmed,
			StatusPaymentFailed,
			StatusCheckoutVerified, // sweeper retry (RecordRetry combinator)
			StatusExpired:
			return true
		}
	}
	return false
}

// IsBareTransitionAllowed reports whether (from, to) may be driven by the
// bare Transition method. The combinator-only edges
// (CREATED→CHECKOUT_VERIFIED, CHECKOUT_VERIFIED→PAYMENT_CONFIRMED,
// CHECKOUT_VERIFIED→PAYMENT_FAILED, CHECKOUT_VERIFIED→CHECKOUT_VERIFIED) are
// excluded so callers cannot bypass the combinators' co-write invariants.
func IsBareTransitionAllowed(from, to Status) bool {
	switch from {
	case StatusCreated:
		switch to {
		case StatusExpired, StatusCancelled:
			return true
		}
	case StatusCheckoutVerified:
		switch to {
		case StatusExpired:
			return true
		}
	}
	return false
}
