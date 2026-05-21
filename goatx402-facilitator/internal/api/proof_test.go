package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
	"github.com/goatnetwork/goatx402-receipt"
)

// stubReceiptReader returns a fixed receipt for one orderID and ErrReceiptNotFound otherwise.
type stubReceiptReader struct {
	id  string
	r   receipt.CantonReceipt
}

func (s *stubReceiptReader) LoadReceipt(_ context.Context, orderID string) (receipt.CantonReceipt, error) {
	if orderID != s.id {
		return receipt.CantonReceipt{}, api.ErrReceiptNotFound
	}
	return s.r, nil
}

func TestProof_NotConfirmedYet(t *testing.T) {
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)

	d := api.ProofDeps{
		Store:      st,
		Receipts:   &stubReceiptReader{},
		TokenStore: create.TokenStore,
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/"+orderID+"/proof", nil)
	r.Header.Set("X-Payer-Token", token)
	w = httptest.NewRecorder()
	api.ProofHandler(d)(w, r, orderID)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 NOT_CONFIRMED on CREATED order, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "NOT_CONFIRMED") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestProof_AuthFailureRecordsAudit(t *testing.T) {
	st := newTestStore(t)
	create, _ := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	// Use the token to create the order, then forget it for the proof call.
	_, token := newCreateOrderDeps(t, st)
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)

	auditCalled := false
	d := api.ProofDeps{
		Store:      st,
		Receipts:   &stubReceiptReader{},
		TokenStore: create.TokenStore,
		AuditFn: func(_ context.Context, id, reason string) {
			auditCalled = true
			if id != orderID {
				t.Errorf("audit id=%s want %s", id, orderID)
			}
			if !strings.Contains(reason, "auth failure") {
				t.Errorf("audit reason=%s", reason)
			}
		},
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/"+orderID+"/proof", nil)
	// no header
	w = httptest.NewRecorder()
	api.ProofHandler(d)(w, r, orderID)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if !auditCalled {
		t.Fatalf("expected audit emission")
	}
}

func TestProof_SuccessReturnsReceiptAndAudits(t *testing.T) {
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)

	// Bypass the state machine for the test: directly write a confirmed
	// order + receipt via the store's combinators isn't viable without a
	// real Canton round trip. Instead, drop a parallel CompletedAt receipt
	// and inject status via raw SQL — but we want to avoid touching SQL
	// here. Easier path: assert the 409 NOT_CONFIRMED branch is what fires
	// when the order is in CREATED, AND separately exercise the success
	// branch with a hand-built Order fixture by re-using the store.
	//
	// Concretely: we already cover the NOT_CONFIRMED branch above; for the
	// happy-path assertion we substitute the store with a tiny stub.
	stub := &stubReceiptReader{
		id: orderID,
		r:  receipt.CantonReceipt{OrderID: orderID, Domain: receipt.DomainV1, Version: receipt.SchemaVersion},
	}
	d := api.ProofDeps{
		Store:      forceConfirmedStore{real: st, orderID: orderID},
		Receipts:   stub,
		TokenStore: create.TokenStore,
		AuditFn:    func(_ context.Context, _ string, _ string) {},
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/"+orderID+"/proof", nil)
	r.Header.Set("X-Payer-Token", token)
	w = httptest.NewRecorder()
	api.ProofHandler(d)(w, r, orderID)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), orderID) {
		t.Fatalf("body=%s", w.Body.String())
	}
}

// forceConfirmedStore overlays the underlying store and reports
// StatusPaymentConfirmed for the bound orderID. Every other store method
// passes through.
type forceConfirmedStore struct {
	real    *store.SQLiteStore
	orderID string
}

func (f forceConfirmedStore) Get(ctx context.Context, id string) (store.Order, error) {
	o, err := f.real.Get(ctx, id)
	if err != nil {
		return o, err
	}
	if id == f.orderID {
		o.Status = store.StatusPaymentConfirmed
	}
	return o, nil
}

func (f forceConfirmedStore) Create(ctx context.Context, o store.Order) error {
	return f.real.Create(ctx, o)
}
func (f forceConfirmedStore) Transition(ctx context.Context, id string, from, to store.Status, version int64, reason string) (store.Order, error) {
	return f.real.Transition(ctx, id, from, to, version, reason)
}
func (f forceConfirmedStore) TransitionAndArmRetry(ctx context.Context, id string, fromVersion int64, commandID string, initialNextAt time.Time) (store.Order, error) {
	return f.real.TransitionAndArmRetry(ctx, id, fromVersion, commandID, initialNextAt)
}
func (f forceConfirmedStore) SaveReceiptAndConfirm(ctx context.Context, orderID string, r receipt.CantonReceipt, fromVersion int64) (store.Order, error) {
	return f.real.SaveReceiptAndConfirm(ctx, orderID, r, fromVersion)
}
func (f forceConfirmedStore) RecordRetry(ctx context.Context, id, code, msg string, nextAt time.Time, fromVersion int64) (store.Order, error) {
	return f.real.RecordRetry(ctx, id, code, msg, nextAt, fromVersion)
}
func (f forceConfirmedStore) MarkPaymentFailedAfterMaxRetries(ctx context.Context, id string, fromVersion int64, reason string) (store.Order, error) {
	return f.real.MarkPaymentFailedAfterMaxRetries(ctx, id, fromVersion, reason)
}
func (f forceConfirmedStore) ListExpiredCandidates(ctx context.Context, asOf time.Time, limit int) ([]store.Order, error) {
	return f.real.ListExpiredCandidates(ctx, asOf, limit)
}
func (f forceConfirmedStore) ListRetryCandidates(ctx context.Context, asOf time.Time, limit int) ([]store.Order, error) {
	return f.real.ListRetryCandidates(ctx, asOf, limit)
}
func (f forceConfirmedStore) Close() error { return f.real.Close() }

// avoid the unused-import linter when middleware isn't directly used here.
var _ = middleware.HeaderXPayerToken
