package flow_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-canton-cli/internal/flow"
	"github.com/goatnetwork/goatx402-receipt"
)

// TestRun_HappyPath_SyncSignature drives the round trip end-to-end against
// the deterministic facilitator + merchant fakes used in auth_test.go and
// asserts the result carries a receipt and the merchant body.
func TestRun_HappyPath_SyncSignature(t *testing.T) {
	const token = "good-token"

	tracker := newHeaderTracker(t)
	facilitator := newFakeFacilitator(t, tracker, token)
	defer facilitator.Close()
	merchant := newFakeMerchant(t, facilitator.URL, tracker)
	defer merchant.Close()

	cfg := flow.Config{
		MerchantURL:         merchant.URL,
		FacilitatorURL:      facilitator.URL,
		Payer:               "Alice",
		PayerToken:          token,
		SourceHolding:       "00:src-cid",
		SourceHoldingOrigin: "flag",
		ResourcePath:        "/resource",
		ExpiresIn:           120,
		Clock:               time.Now,
		PollInterval:        10 * time.Millisecond,
		MaxWait:             2 * time.Second,
		HTTPClient:          http.DefaultClient,
	}
	res, err := flow.Run(context.Background(), cfg)
	if err != nil {
		t.Fatalf("flow run failed: %v", err)
	}
	if res.Outcome != "ok" {
		t.Fatalf("expected ok, got %q", res.Outcome)
	}
	if res.Receipt == nil {
		t.Fatalf("expected receipt populated")
	}
	if res.Receipt.OrderID != "test-order" {
		t.Fatalf("receipt.OrderID = %q, want test-order", res.Receipt.OrderID)
	}
	if res.ResponseBody != "protected-body" {
		t.Fatalf("response body = %q, want protected-body", res.ResponseBody)
	}
	if res.SourceHolding == nil || res.SourceHolding.Source != "flag" {
		t.Fatalf("source-holding info missing")
	}
}

// TestRun_AsyncSignature_PollsToTerminal exercises the path where the
// facilitator returns 202 to /calldata-signature and the CLI must poll
// GET /orders/:id until PAYMENT_CONFIRMED, then GET /proof to fetch the
// receipt.
func TestRun_AsyncSignature_PollsToTerminal(t *testing.T) {
	const token = "good-token"
	tracker := newHeaderTracker(t)

	mux := http.NewServeMux()
	pollCount := int32(0)

	auth := func(w http.ResponseWriter, r *http.Request) bool {
		tok := r.Header.Get("X-Payer-Token")
		tracker.record(r.Method, r.URL.Path, tok)
		if tok != token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"UNAUTHENTICATED"}`))
			return false
		}
		return true
	}

	mux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"x402Version":           1,
			"orderId":               "test-order",
			"nonce":                 "n",
			"status":                "CREATED",
			"submissionPayloadHash": "aGFzaA==",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/custodial-sign", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"signatureScheme": "Ed25519",
			"signature":       "c2ln",
			"publicKey":       "cHVi",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/calldata-signature", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		// Always 202: client must poll for terminal.
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order",
			"status":  "CHECKOUT_VERIFIED",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		status := "CHECKOUT_VERIFIED"
		if atomic.AddInt32(&pollCount, 1) >= 2 {
			status = "PAYMENT_CONFIRMED"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId":    "test-order",
			"status":     status,
			"retryState": "healthy",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/proof", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(receipt.CantonReceipt{
			Version:       "1.0",
			Domain:        receipt.DomainV1,
			OrderID:       "test-order",
			TransactionID: "tx-async",
		})
	})
	facilitator := httptest.NewServer(mux)
	defer facilitator.Close()
	merchant := newFakeMerchant(t, facilitator.URL, tracker)
	defer merchant.Close()

	cfg := flow.Config{
		MerchantURL:         merchant.URL,
		FacilitatorURL:      facilitator.URL,
		Payer:               "Alice",
		PayerToken:          token,
		SourceHolding:       "00:src-cid",
		SourceHoldingOrigin: "fixture",
		ResourcePath:        "/resource",
		ExpiresIn:           120,
		Clock:               time.Now,
		PollInterval:        5 * time.Millisecond,
		MaxWait:             2 * time.Second,
		HTTPClient:          http.DefaultClient,
	}
	res, err := flow.Run(context.Background(), cfg)
	if err != nil {
		t.Fatalf("async flow failed: %v", err)
	}
	if res.Receipt == nil || res.Receipt.TransactionID != "tx-async" {
		t.Fatalf("expected receipt with tx-async, got %+v", res.Receipt)
	}
	if res.ResponseBody != "protected-body" {
		t.Fatalf("response body = %q", res.ResponseBody)
	}
}

// TestRun_MissingPayerToken_FailsBeforeHTTP covers the Task 12 acceptance
// line that the CLI must NOT issue any HTTP call when --payer-token is unset.
// validateConfig short-circuits with MISSING_PAYER_TOKEN.
func TestRun_MissingPayerToken_FailsBeforeHTTP(t *testing.T) {
	called := int32(0)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		atomic.AddInt32(&called, 1)
	}))
	defer srv.Close()
	cfg := flow.Config{
		MerchantURL:    srv.URL,
		FacilitatorURL: srv.URL,
		Payer:          "Alice",
		PayerToken:     "",
		SourceHolding:  "cid",
		ResourcePath:   "/resource",
		Clock:          time.Now,
		HTTPClient:     http.DefaultClient,
	}
	res, err := flow.Run(context.Background(), cfg)
	if err == nil {
		t.Fatalf("expected MISSING_PAYER_TOKEN, got nil")
	}
	if !strings.Contains(err.Error(), "MISSING_PAYER_TOKEN") {
		t.Fatalf("expected MISSING_PAYER_TOKEN, got %v", err)
	}
	if res.Outcome != "MISSING_PAYER_TOKEN" {
		t.Fatalf("expected outcome MISSING_PAYER_TOKEN, got %q", res.Outcome)
	}
	if res.Runbook == "" {
		t.Fatalf("expected runbook hint populated")
	}
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("expected zero HTTP calls before the pre-flight check; got %d", called)
	}
}

// TestRun_MissingSourceHolding_FailsBeforeHTTP mirrors the
// MISSING_SOURCE_HOLDING acceptance.
func TestRun_MissingSourceHolding_FailsBeforeHTTP(t *testing.T) {
	called := int32(0)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		atomic.AddInt32(&called, 1)
	}))
	defer srv.Close()
	cfg := flow.Config{
		MerchantURL:    srv.URL,
		FacilitatorURL: srv.URL,
		Payer:          "Alice",
		PayerToken:     "good",
		SourceHolding:  "",
		ResourcePath:   "/resource",
		Clock:          time.Now,
		HTTPClient:     http.DefaultClient,
	}
	res, err := flow.Run(context.Background(), cfg)
	if err == nil {
		t.Fatalf("expected MISSING_SOURCE_HOLDING")
	}
	if res.Outcome != "MISSING_SOURCE_HOLDING" {
		t.Fatalf("expected outcome MISSING_SOURCE_HOLDING, got %q", res.Outcome)
	}
	if res.Runbook == "" {
		t.Fatalf("expected runbook hint populated")
	}
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("expected zero HTTP calls before pre-flight; got %d", called)
	}
}

// TestRun_PaymentFailedAsync_SurfacesRetryReason exercises the async branch
// where the status endpoint reports PAYMENT_FAILED with a retryLastError —
// the CLI should surface that reason in the error message rather than
// hanging.
func TestRun_PaymentFailedAsync_SurfacesRetryReason(t *testing.T) {
	const token = "good"
	tracker := newHeaderTracker(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		tracker.record(r.Method, r.URL.Path, r.Header.Get("X-Payer-Token"))
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order", "nonce": "n", "status": "CREATED",
			"submissionPayloadHash": "aGFzaA==", "x402Version": 1,
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/custodial-sign", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"signatureScheme": "Ed25519", "signature": "c2ln", "publicKey": "cHVi",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/calldata-signature", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"orderId": "test-order", "status": "CHECKOUT_VERIFIED"})
	})
	reason := "INSUFFICIENT_HOLDING"
	mux.HandleFunc("/api/v1/orders/test-order", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order", "status": "PAYMENT_FAILED",
			"retryState": "exhausted", "retryLastError": reason,
		})
	})
	facilitator := httptest.NewServer(mux)
	defer facilitator.Close()
	merchant := newFakeMerchant(t, facilitator.URL, tracker)
	defer merchant.Close()

	cfg := flow.Config{
		MerchantURL:    merchant.URL,
		FacilitatorURL: facilitator.URL,
		Payer:          "Alice",
		PayerToken:     token,
		SourceHolding:  "cid",
		ResourcePath:   "/resource",
		PollInterval:   5 * time.Millisecond,
		MaxWait:        500 * time.Millisecond,
		Clock:          time.Now,
		HTTPClient:     http.DefaultClient,
	}
	_, err := flow.Run(context.Background(), cfg)
	if err == nil {
		t.Fatalf("expected PAYMENT_FAILED to surface")
	}
	if !strings.Contains(err.Error(), "PAYMENT_FAILED") || !strings.Contains(err.Error(), reason) {
		t.Fatalf("expected PAYMENT_FAILED + reason in error, got %v", err)
	}
}

// TestRun_PropagatesContextCancellation makes sure ctx.Done bubbles out
// cleanly instead of leaking goroutines.
func TestRun_PropagatesContextCancellation(t *testing.T) {
	const token = "good"
	tracker := newHeaderTracker(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		tracker.record(r.Method, r.URL.Path, r.Header.Get("X-Payer-Token"))
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order", "x402Version": 1, "nonce": "n",
			"status": "CREATED", "submissionPayloadHash": "aGFzaA==",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/custodial-sign", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"signatureScheme": "Ed25519", "signature": "c2ln", "publicKey": "cHVi",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/calldata-signature", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"orderId": "test-order", "status": "CHECKOUT_VERIFIED"})
	})
	mux.HandleFunc("/api/v1/orders/test-order", func(w http.ResponseWriter, r *http.Request) {
		// Never reaches terminal — keeps the client polling.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order", "status": "CHECKOUT_VERIFIED",
			"retryState": "healthy",
		})
	})
	facilitator := httptest.NewServer(mux)
	defer facilitator.Close()
	merchant := newFakeMerchant(t, facilitator.URL, tracker)
	defer merchant.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	cfg := flow.Config{
		MerchantURL:    merchant.URL,
		FacilitatorURL: facilitator.URL,
		Payer:          "Alice",
		PayerToken:     token,
		SourceHolding:  "cid",
		ResourcePath:   "/resource",
		PollInterval:   10 * time.Millisecond,
		MaxWait:        1 * time.Second,
		Clock:          time.Now,
		HTTPClient:     http.DefaultClient,
	}
	_, err := flow.Run(ctx, cfg)
	if err == nil {
		t.Fatalf("expected ctx-cancel error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) && !strings.Contains(err.Error(), "context") && !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected context error, got %v", err)
	}
}
