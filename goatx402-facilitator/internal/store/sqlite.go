package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	// SQLite driver. CGO must be enabled at build time.
	_ "github.com/mattn/go-sqlite3"

	"github.com/goatnetwork/goatx402-receipt"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// SQLiteStore is the concrete OrderStore backed by SQLite (driver:
// github.com/mattn/go-sqlite3). All public methods are safe for concurrent
// use; the underlying *sql.DB owns the connection pool.
//
// Concurrency model: every state-mutating method opens a single
// IMMEDIATE transaction (BEGIN IMMEDIATE) so the CAS UPDATE is serialised
// against other writers; readers may proceed in parallel.
type SQLiteStore struct {
	db  *sql.DB
	now func() time.Time

	// testHookBeforeCommit, if non-nil, runs inside SaveReceiptAndConfirm
	// after the receipt INSERT and the CAS UPDATE but BEFORE the COMMIT.
	// Returning a non-nil error aborts the transaction and is reported
	// back to the caller verbatim. Used by store_test.go to exercise the
	// kill-test atomicity invariant without needing an actual SIGKILL.
	testHookBeforeCommit func(*sql.Tx) error

	closeOnce sync.Once
}

// SQLiteOptions tunes the SQLite store.
type SQLiteOptions struct {
	// DSN is the sqlite3 DSN. Defaults to ":memory:" if empty. Callers
	// who need WAL-on-disk should pass e.g.
	// "file:orders.db?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=1".
	DSN string

	// Now is the clock for created_at / updated_at. Defaults to time.Now.
	// Tests inject a deterministic clock here.
	Now func() time.Time

	// MigrateOnOpen runs migrations against the connection during Open().
	// Defaults to true. Production prefers a one-shot `facilitator migrate`
	// subcommand; tests rely on the default.
	MigrateOnOpen bool

	// MaxOpenConns / MaxIdleConns. Zero values inherit database/sql defaults.
	MaxOpenConns int
	MaxIdleConns int
}

// Open opens an SQLite store with sensible defaults applied.
func Open(opts SQLiteOptions) (*SQLiteStore, error) {
	dsn := opts.DSN
	if dsn == "" {
		// Shared in-memory DB so multiple connections in the same pool
		// see the same data; otherwise mattn/go-sqlite3 gives each
		// connection a private database.
		dsn = "file::memory:?cache=shared&_busy_timeout=5000&_foreign_keys=1"
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open sqlite: %w", err)
	}
	// SQLite is fundamentally single-writer (the "database is locked"
	// failure mode otherwise dominates under any concurrent CAS load).
	// Pin to 1 connection unless the caller explicitly opts up — the
	// race-test relies on writers serialising at the pool, not at the
	// SQLite VFS layer. PostgreSQL swap-out at v1 lifts the cap.
	maxOpen := opts.MaxOpenConns
	if maxOpen <= 0 {
		maxOpen = 1
	}
	db.SetMaxOpenConns(maxOpen)
	if opts.MaxIdleConns > 0 {
		db.SetMaxIdleConns(opts.MaxIdleConns)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: ping sqlite: %w", err)
	}

	s := &SQLiteStore{db: db, now: now}

	migrate := opts.MigrateOnOpen || (!opts.MigrateOnOpen && opts.DSN == "")
	if opts.DSN != "" && !opts.MigrateOnOpen {
		migrate = false
	}
	if migrate {
		if err := s.Migrate(context.Background()); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return s, nil
}

// DB exposes the underlying *sql.DB for callers that need to attach their
// own queries (e.g. the canton tx-stream offset checkpoint).
func (s *SQLiteStore) DB() *sql.DB { return s.db }

// Close shuts down the connection pool. Safe to call multiple times.
func (s *SQLiteStore) Close() error {
	var err error
	s.closeOnce.Do(func() { err = s.db.Close() })
	return err
}

// Migrate applies every embedded migration in numeric order. Safe to re-run
// (each migration is CREATE … IF NOT EXISTS).
func (s *SQLiteStore) Migrate(ctx context.Context) error {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("store: read embedded migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		body, err := migrationFS.ReadFile(path.Join("migrations", name))
		if err != nil {
			return fmt.Errorf("store: read migration %s: %w", name, err)
		}
		if _, err := s.db.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("store: apply migration %s: %w", name, err)
		}
	}
	return nil
}

// ----- Create / Get -----

func (s *SQLiteStore) Create(ctx context.Context, o Order) error {
	if !IsValidStatus(o.Status) {
		return ErrInvalidStatus
	}
	if o.Status != StatusCreated {
		return fmt.Errorf("store: Create requires StatusCreated (got %q): %w", o.Status, ErrIllegalTransition)
	}
	now := s.now().UnixMilli()
	if o.CreatedAt == 0 {
		o.CreatedAt = now
	}
	if o.UpdatedAt == 0 {
		o.UpdatedAt = now
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin Create tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	const q = `
INSERT INTO orders (
    id, status, amount, currency, trusted_issuer, merchant, payer, resource,
    nonce, memo, expires_at, dedup_id, payload_hash, merchant_request_id,
    client_request_id, request_fingerprint, source_holding_contract_id,
    command_id, retry_count, retry_last_error, retry_next_at,
    created_at, updated_at, status_version
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?
);`
	_, err = tx.ExecContext(ctx, q,
		o.ID, string(o.Status), o.Amount, o.Currency, o.TrustedIssuer, o.Merchant, o.Payer, o.Resource,
		o.Nonce, nullableString(o.Memo), o.ExpiresAt, o.DedupID, o.PayloadHash, o.MerchantRequestID,
		nullableString(o.ClientRequestID), nullableBytes(o.RequestFingerprint), o.SourceHoldingContractID,
		nullableString(o.CommandID), o.RetryCount, nullableString(o.RetryLastError), nullableInt64(o.RetryNextAt),
		o.CreatedAt, o.UpdatedAt, o.StatusVersion,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return fmt.Errorf("store: insert order: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, NULL, ?, ?, ?);`,
		o.ID, string(o.Status), o.CreatedAt, "created",
	); err != nil {
		return fmt.Errorf("store: insert creation event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit Create: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Get(ctx context.Context, id string) (Order, error) {
	row := s.db.QueryRowContext(ctx, selectOrderByID, id)
	return scanOrder(row)
}

// ----- bare Transition -----

func (s *SQLiteStore) Transition(
	ctx context.Context,
	id string,
	from, to Status,
	version int64,
	reason string,
) (Order, error) {
	if !IsValidStatus(from) || !IsValidStatus(to) {
		return Order{}, ErrInvalidStatus
	}
	if !IsBareTransitionAllowed(from, to) {
		return Order{}, ErrIllegalTransition
	}
	now := s.now().UnixMilli()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Order{}, fmt.Errorf("store: begin Transition tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE orders
		    SET status = ?, status_version = status_version + 1, updated_at = ?
		  WHERE id = ? AND status = ? AND status_version = ?;`,
		string(to), now, id, string(from), version,
	)
	if err != nil {
		return Order{}, fmt.Errorf("store: CAS update: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Order{}, fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		// Distinguish missing-row from CAS miss for nicer errors.
		var exists int
		_ = tx.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE id = ? LIMIT 1;`, id).Scan(&exists)
		if exists == 0 {
			return Order{}, ErrNotFound
		}
		return Order{}, ErrCASFailed
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?);`,
		id, string(from), string(to), now, reason,
	); err != nil {
		return Order{}, fmt.Errorf("store: append order_event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Order{}, fmt.Errorf("store: commit Transition: %w", err)
	}
	return s.Get(ctx, id)
}

// ----- TransitionAndArmRetry -----

func (s *SQLiteStore) TransitionAndArmRetry(
	ctx context.Context,
	id string,
	fromVersion int64,
	commandID string,
	initialNextAt time.Time,
) (Order, error) {
	if commandID == "" {
		return Order{}, fmt.Errorf("store: TransitionAndArmRetry requires non-empty commandID")
	}
	now := s.now().UnixMilli()
	nextAtMS := initialNextAt.UnixMilli()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Order{}, fmt.Errorf("store: begin TransitionAndArmRetry tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE orders
		    SET status = ?,
		        status_version = status_version + 1,
		        command_id = ?,
		        retry_count = 0,
		        retry_last_error = NULL,
		        retry_next_at = ?,
		        updated_at = ?
		  WHERE id = ? AND status = ? AND status_version = ?;`,
		string(StatusCheckoutVerified), commandID, nextAtMS, now,
		id, string(StatusCreated), fromVersion,
	)
	if err != nil {
		return Order{}, fmt.Errorf("store: CAS+arm update: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Order{}, fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		var exists int
		_ = tx.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE id = ? LIMIT 1;`, id).Scan(&exists)
		if exists == 0 {
			return Order{}, ErrNotFound
		}
		return Order{}, ErrCASFailed
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?);`,
		id, string(StatusCreated), string(StatusCheckoutVerified), now, "checkout-verified+arm",
	); err != nil {
		return Order{}, fmt.Errorf("store: append order_event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Order{}, fmt.Errorf("store: commit TransitionAndArmRetry: %w", err)
	}
	return s.Get(ctx, id)
}

// ----- SaveReceiptAndConfirm -----

func (s *SQLiteStore) SaveReceiptAndConfirm(
	ctx context.Context,
	orderID string,
	r receipt.CantonReceipt,
	fromVersion int64,
) (Order, error) {
	now := s.now().UnixMilli()

	sigBytes, err := decodeBase64StrictRequired(r.Signature)
	if err != nil {
		return Order{}, fmt.Errorf("store: receipt signature: %w", err)
	}
	hashBytes, err := decodeBase64StrictRequired(r.ReceiptPayloadHash)
	if err != nil {
		return Order{}, fmt.Errorf("store: receipt payload_hash: %w", err)
	}
	rawJSON, err := json.Marshal(r)
	if err != nil {
		return Order{}, fmt.Errorf("store: marshal receipt: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Order{}, fmt.Errorf("store: begin SaveReceiptAndConfirm tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 1. INSERT receipt.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO receipts (
		    order_id, ledger_id, tx_id, contract_id, payment_request_contract_id,
		    participant_party, signature_scheme, signature, payload_hash,
		    completed_at, raw_json, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		orderID, r.LedgerID, r.TransactionID, r.ContractID, r.PaymentRequestContractID,
		r.ParticipantPartyID, r.SignatureScheme, sigBytes, hashBytes,
		r.CompletedAt, string(rawJSON), now,
	); err != nil {
		if isUniqueViolation(err) {
			// A receipt row already exists — the only way this happens
			// is a concurrent SaveReceiptAndConfirm that already won.
			// Treat as CAS-loss for the caller; the winner already
			// wrote the canonical receipt.
			return Order{}, ErrCASFailed
		}
		return Order{}, fmt.Errorf("store: insert receipt: %w", err)
	}

	// 2. CAS-transition CHECKOUT_VERIFIED → PAYMENT_CONFIRMED.
	res, err := tx.ExecContext(ctx,
		`UPDATE orders
		    SET status = ?, status_version = status_version + 1,
		        retry_next_at = NULL, retry_last_error = NULL,
		        updated_at = ?
		  WHERE id = ? AND status = ? AND status_version = ?;`,
		string(StatusPaymentConfirmed), now, orderID,
		string(StatusCheckoutVerified), fromVersion,
	)
	if err != nil {
		return Order{}, fmt.Errorf("store: CAS confirm: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Order{}, fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		var exists int
		_ = tx.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE id = ? LIMIT 1;`, orderID).Scan(&exists)
		if exists == 0 {
			return Order{}, ErrNotFound
		}
		return Order{}, ErrCASFailed
	}

	// 3. Append order_event in the same SQL tx.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?);`,
		orderID, string(StatusCheckoutVerified), string(StatusPaymentConfirmed), now, "receipt+confirm",
	); err != nil {
		return Order{}, fmt.Errorf("store: append order_event: %w", err)
	}

	// 4. Test-only kill-test hook. Returning an error here MUST leave
	// the database in the pre-call state (no orphan receipt, status
	// remains CHECKOUT_VERIFIED) — that is the atomicity invariant we
	// are exercising in store_test.go.
	if s.testHookBeforeCommit != nil {
		if err := s.testHookBeforeCommit(tx); err != nil {
			return Order{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return Order{}, fmt.Errorf("store: commit SaveReceiptAndConfirm: %w", err)
	}
	return s.Get(ctx, orderID)
}

// ----- RecordRetry -----

func (s *SQLiteStore) RecordRetry(
	ctx context.Context,
	orderID string,
	gRPCCode string,
	errMsg string,
	nextAt time.Time,
	fromVersion int64,
) (Order, error) {
	now := s.now().UnixMilli()
	nextMS := nextAt.UnixMilli()
	// The reason field in order_events records both code and message but
	// truncates at a sensible length so a flood of long messages cannot
	// blow up the audit table.
	reason := truncate(fmt.Sprintf("retry: %s: %s", gRPCCode, errMsg), 512)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Order{}, fmt.Errorf("store: begin RecordRetry tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE orders
		    SET status_version = status_version + 1,
		        retry_count = retry_count + 1,
		        retry_last_error = ?,
		        retry_next_at = ?,
		        updated_at = ?
		  WHERE id = ? AND status = ? AND status_version = ?;`,
		truncate(fmt.Sprintf("%s: %s", gRPCCode, errMsg), 512), nextMS, now,
		orderID, string(StatusCheckoutVerified), fromVersion,
	)
	if err != nil {
		return Order{}, fmt.Errorf("store: CAS retry: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Order{}, fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		var exists int
		_ = tx.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE id = ? LIMIT 1;`, orderID).Scan(&exists)
		if exists == 0 {
			return Order{}, ErrNotFound
		}
		return Order{}, ErrCASFailed
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?);`,
		orderID, string(StatusCheckoutVerified), string(StatusCheckoutVerified), now, reason,
	); err != nil {
		return Order{}, fmt.Errorf("store: append order_event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Order{}, fmt.Errorf("store: commit RecordRetry: %w", err)
	}
	return s.Get(ctx, orderID)
}

// ----- MarkPaymentFailedAfterMaxRetries -----

func (s *SQLiteStore) MarkPaymentFailedAfterMaxRetries(
	ctx context.Context,
	orderID string,
	fromVersion int64,
	reason string,
) (Order, error) {
	now := s.now().UnixMilli()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Order{}, fmt.Errorf("store: begin MarkPaymentFailed tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE orders
		    SET status = ?, status_version = status_version + 1,
		        retry_next_at = NULL, updated_at = ?
		  WHERE id = ? AND status = ? AND status_version = ?;`,
		string(StatusPaymentFailed), now,
		orderID, string(StatusCheckoutVerified), fromVersion,
	)
	if err != nil {
		return Order{}, fmt.Errorf("store: CAS fail: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Order{}, fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		var exists int
		_ = tx.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE id = ? LIMIT 1;`, orderID).Scan(&exists)
		if exists == 0 {
			return Order{}, ErrNotFound
		}
		return Order{}, ErrCASFailed
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO order_events (order_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?);`,
		orderID, string(StatusCheckoutVerified), string(StatusPaymentFailed), now, truncate(reason, 512),
	); err != nil {
		return Order{}, fmt.Errorf("store: append order_event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Order{}, fmt.Errorf("store: commit MarkPaymentFailed: %w", err)
	}
	return s.Get(ctx, orderID)
}

// ----- Sweeper helpers -----

func (s *SQLiteStore) ListExpiredCandidates(ctx context.Context, asOf time.Time, limit int) ([]Order, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		selectOrdersBase+`
		WHERE expires_at <= ?
		  AND status IN (?, ?)
		ORDER BY expires_at ASC
		LIMIT ?;`,
		asOf.UnixMilli(), string(StatusCreated), string(StatusCheckoutVerified), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: query expired: %w", err)
	}
	defer rows.Close()
	return scanOrders(rows)
}

func (s *SQLiteStore) ListRetryCandidates(ctx context.Context, asOf time.Time, limit int) ([]Order, error) {
	if limit <= 0 {
		limit = 100
	}
	// Backed by the partial index idx_orders_retry_next_at.
	rows, err := s.db.QueryContext(ctx,
		selectOrdersBase+`
		WHERE retry_next_at IS NOT NULL
		  AND retry_next_at <= ?
		  AND status = ?
		ORDER BY retry_next_at ASC
		LIMIT ?;`,
		asOf.UnixMilli(), string(StatusCheckoutVerified), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: query retry candidates: %w", err)
	}
	defer rows.Close()
	return scanOrders(rows)
}

// ----- Scanning helpers -----

const selectOrdersBase = `SELECT
    id, status, amount, currency, trusted_issuer, merchant, payer, resource,
    nonce, memo, expires_at, dedup_id, payload_hash, merchant_request_id,
    client_request_id, request_fingerprint, source_holding_contract_id,
    command_id, retry_count, retry_last_error, retry_next_at,
    created_at, updated_at, status_version
FROM orders`

const selectOrderByID = selectOrdersBase + ` WHERE id = ?;`

type scanner interface {
	Scan(dest ...any) error
}

func scanOrder(s scanner) (Order, error) {
	var (
		o          Order
		status     string
		memo       sql.NullString
		clientReq  sql.NullString
		fingerPrt  []byte
		commandID  sql.NullString
		retryErr   sql.NullString
		retryNext  sql.NullInt64
	)
	err := s.Scan(
		&o.ID, &status, &o.Amount, &o.Currency, &o.TrustedIssuer, &o.Merchant, &o.Payer, &o.Resource,
		&o.Nonce, &memo, &o.ExpiresAt, &o.DedupID, &o.PayloadHash, &o.MerchantRequestID,
		&clientReq, &fingerPrt, &o.SourceHoldingContractID,
		&commandID, &o.RetryCount, &retryErr, &retryNext,
		&o.CreatedAt, &o.UpdatedAt, &o.StatusVersion,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Order{}, ErrNotFound
		}
		return Order{}, fmt.Errorf("store: scan order: %w", err)
	}
	o.Status = Status(status)
	if memo.Valid {
		v := memo.String
		o.Memo = &v
	}
	if clientReq.Valid {
		v := clientReq.String
		o.ClientRequestID = &v
	}
	o.RequestFingerprint = fingerPrt
	if commandID.Valid {
		v := commandID.String
		o.CommandID = &v
	}
	if retryErr.Valid {
		v := retryErr.String
		o.RetryLastError = &v
	}
	if retryNext.Valid {
		v := retryNext.Int64
		o.RetryNextAt = &v
	}
	return o, nil
}

func scanOrders(rows *sql.Rows) ([]Order, error) {
	out := make([]Order, 0, 16)
	for rows.Next() {
		o, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: iterate orders: %w", err)
	}
	return out, nil
}

// ----- Misc helpers -----

func nullableString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullableBytes(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}

func nullableInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func decodeBase64StrictRequired(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("empty base64")
	}
	return base64.StdEncoding.DecodeString(s)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// isUniqueViolation peeks at the underlying mattn/go-sqlite3 error to detect
// a UNIQUE constraint failure. Wrapped here so the rest of the package does
// not have to import the driver type.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	// mattn/go-sqlite3 surfaces UNIQUE failures as text. Avoid importing
	// the driver's error struct so the rest of the package stays
	// driver-agnostic.
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "constraint failed: UNIQUE")
}
