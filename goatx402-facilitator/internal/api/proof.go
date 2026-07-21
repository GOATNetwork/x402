package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
	"github.com/goatnetwork/goatx402-receipt"
)

// ReceiptReader is the read-only seam Task 9 uses to fetch the persisted
// CantonReceipt blob. Task 7 owns the orders/receipts tables; the read path
// here is a thin SELECT on receipts.raw_json so the api layer never
// re-canonicalises the receipt on its own.
type ReceiptReader interface {
	// LoadReceipt returns the canonical CantonReceipt for orderID. Returns
	// ErrReceiptNotFound when the order has none yet.
	LoadReceipt(ctx context.Context, orderID string) (receipt.CantonReceipt, error)
}

// ErrReceiptNotFound is returned by ReceiptReader implementations when the
// receipts table has no row for orderID yet.
var ErrReceiptNotFound = errors.New("api: receipt not found")

// ProofDeps carries dependencies for GET /:id/proof.
type ProofDeps struct {
	Store      store.OrderStore
	Receipts   ReceiptReader
	TokenStore middleware.PayerTokenStore
	AuditFn    func(ctx context.Context, orderID, reason string)
}

// ProofHandler returns the GET /api/v1/orders/:id/proof handler.
func ProofHandler(d ProofDeps) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, orderID string) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		o, err := d.Store.Get(r.Context(), orderID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErrorWithOrder(w, http.StatusNotFound, ErrOrderNotFound, "order not found", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load order", orderID)
			return
		}
		tok := r.Header.Get(middleware.HeaderXPayerToken)
		ok, code := middleware.AssertBoundToParty(tok, o.Payer, d.TokenStore)
		if !ok {
			d.audit(r.Context(), orderID, "auth failure on GET /:id/proof")
			status := http.StatusUnauthorized
			ec := ErrUnauthenticated
			if code == "PAYER_NOT_BOUND" {
				status = http.StatusForbidden
				ec = ErrPayerNotBound
			}
			writeErrorWithOrder(w, status, ec, "X-Payer-Token check failed", orderID)
			return
		}
		if o.Status != store.StatusPaymentConfirmed {
			writeErrorWithOrder(w, http.StatusConflict, ErrNotConfirmed, "status is not PAYMENT_CONFIRMED", orderID)
			return
		}
		r2, err := d.Receipts.LoadReceipt(r.Context(), orderID)
		if err != nil {
			if errors.Is(err, ErrReceiptNotFound) {
				writeErrorWithOrder(w, http.StatusConflict, ErrNotConfirmed, "receipt not persisted yet", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load receipt", orderID)
			return
		}
		d.audit(r.Context(), orderID, "proof retrieved")
		writeJSON(w, http.StatusOK, r2)
	}
}

func (d ProofDeps) audit(ctx context.Context, orderID, reason string) {
	if d.AuditFn != nil {
		d.AuditFn(ctx, orderID, reason)
	}
}

// ---- SQLite-backed default ReceiptReader -----------------------------

// SQLReceiptReader reads raw_json directly from the receipts table. It is the
// default implementation main.go wires; tests inject a fake satisfying
// ReceiptReader.
type SQLReceiptReader struct {
	DB *sql.DB
}

// LoadReceipt implements ReceiptReader.
func (r *SQLReceiptReader) LoadReceipt(ctx context.Context, orderID string) (receipt.CantonReceipt, error) {
	if r == nil || r.DB == nil {
		return receipt.CantonReceipt{}, fmt.Errorf("api: nil receipt reader")
	}
	var raw string
	err := r.DB.QueryRowContext(ctx,
		`SELECT raw_json FROM receipts WHERE order_id = ?;`, orderID).Scan(&raw)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return receipt.CantonReceipt{}, ErrReceiptNotFound
		}
		return receipt.CantonReceipt{}, err
	}
	var out receipt.CantonReceipt
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return receipt.CantonReceipt{}, fmt.Errorf("api: decode receipt raw_json: %w", err)
	}
	return out, nil
}
