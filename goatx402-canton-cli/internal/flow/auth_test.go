package flow_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-canton-cli/internal/flow"
	"github.com/goatnetwork/goatx402-receipt"
)

// TestAuth_XPayerTokenSetOnEveryFacilitatorRequest covers the round-3 Codex
// P0 fix called out in PLAN.md Task 12: every facilitator endpoint requires
// X-Payer-Token, so the CLI MUST attach the same header to every call.
// We exercise both code paths so that POST /orders, POST /custodial-sign,
// POST /calldata-signature, GET /orders/:id, and GET /orders/:id/proof all
// fire across the suite.
func TestAuth_XPayerTokenSetOnEveryFacilitatorRequest(t *testing.T) {
	const token = "token-aaaa-1111"

	t.Run("sync_path_covers_create_sign_calldata", func(t *testing.T) {
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
		if _, err := flow.Run(context.Background(), cfg); err != nil {
			t.Fatalf("sync flow failed: %v", err)
		}
		want := map[string]bool{
			"POST /api/v1/orders":                               false,
			"POST /api/v1/orders/test-order/custodial-sign":     false,
			"POST /api/v1/orders/test-order/calldata-signature": false,
		}
		tracker.assertAllAuthed(t, token, want)
	})

	t.Run("async_path_additionally_covers_status_and_proof", func(t *testing.T) {
		tracker := newHeaderTracker(t)
		facilitator := newFakeAsyncFacilitator(t, tracker, token)
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
			PollInterval:        5 * time.Millisecond,
			MaxWait:             2 * time.Second,
			HTTPClient:          http.DefaultClient,
		}
		if _, err := flow.Run(context.Background(), cfg); err != nil {
			t.Fatalf("async flow failed: %v", err)
		}
		want := map[string]bool{
			"POST /api/v1/orders":                               false,
			"POST /api/v1/orders/test-order/custodial-sign":     false,
			"POST /api/v1/orders/test-order/calldata-signature": false,
			"GET /api/v1/orders/test-order":                     false,
			"GET /api/v1/orders/test-order/proof":               false,
		}
		tracker.assertAllAuthed(t, token, want)
	})
}

// TestAuth_FacilitatorWrongTokenSurfacesCleanDiagnostic covers the Task 12
// acceptance line: "with a wrong token, the facilitator returns 401 and the
// CLI surfaces a clean diagnostic".
func TestAuth_FacilitatorWrongTokenSurfacesCleanDiagnostic(t *testing.T) {
	const goodToken = "good"
	tracker := newHeaderTracker(t)
	facilitator := newFakeFacilitator(t, tracker, goodToken)
	defer facilitator.Close()
	merchant := newFakeMerchant(t, facilitator.URL, tracker)
	defer merchant.Close()

	cfg := flow.Config{
		MerchantURL:         merchant.URL,
		FacilitatorURL:      facilitator.URL,
		Payer:               "Alice",
		PayerToken:          "wrong-token",
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
	if err == nil {
		t.Fatalf("expected wrong-token flow to fail")
	}
	if res.Outcome == "ok" {
		t.Fatalf("expected non-ok outcome, got %q", res.Outcome)
	}
	if res.ErrorMessage == "" {
		t.Fatalf("expected ErrorMessage populated, got empty")
	}
	if res.Outcome != "UNAUTHENTICATED" {
		// Anything else would mean we surfaced something other than the
		// facilitator's clean 401 body.
		t.Fatalf("expected outcome UNAUTHENTICATED, got %q (err=%v)", res.Outcome, err)
	}
}

// ----------------------------------------------------------------------------
// Fakes shared by auth_test.go and flow_test.go.
// ----------------------------------------------------------------------------

type headerTracker struct {
	mu        sync.Mutex
	seen      map[string]string // "METHOD path" -> token
}

func newHeaderTracker(_ *testing.T) *headerTracker {
	return &headerTracker{seen: map[string]string{}}
}

func (h *headerTracker) record(method, path, token string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seen[method+" "+path] = token
}

func (h *headerTracker) assertAllAuthed(t *testing.T, wantToken string, expected map[string]bool) {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	for k := range expected {
		tok, ok := h.seen[k]
		if !ok {
			t.Errorf("expected %s to have been called, was not", k)
			continue
		}
		if tok != wantToken {
			t.Errorf("%s X-Payer-Token = %q, want %q", k, tok, wantToken)
		}
	}
}

// newFakeFacilitator stands up a deterministic facilitator that
// (a) records every X-Payer-Token header into the tracker and
// (b) returns the minimal JSON shapes the flow consumes.
// The token argument is the *expected* token; mismatches return 401 with the
// canonical error envelope.
func newFakeFacilitator(t *testing.T, tracker *headerTracker, expectToken string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	authCheck := func(w http.ResponseWriter, r *http.Request) bool {
		tok := r.Header.Get("X-Payer-Token")
		tracker.record(r.Method, r.URL.Path, tok)
		if tok != expectToken {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"UNAUTHENTICATED","message":"bad token"}`))
			return false
		}
		return true
	}

	mux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		if !authCheck(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"x402Version":           1,
			"orderId":               "test-order",
			"nonce":                 "nonce",
			"status":                "CREATED",
			"submissionPayloadHash": "aGFzaA==",
			"accepts":               []any{},
		})
	})

	mux.HandleFunc("/api/v1/orders/test-order/custodial-sign", func(w http.ResponseWriter, r *http.Request) {
		if !authCheck(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"signatureScheme": "Ed25519",
			"signature":       base64.StdEncoding.EncodeToString([]byte("sig")),
			"publicKey":       base64.StdEncoding.EncodeToString([]byte("pub")),
		})
	})

	mux.HandleFunc("/api/v1/orders/test-order/calldata-signature", func(w http.ResponseWriter, r *http.Request) {
		if !authCheck(w, r) {
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order",
			"status":  "PAYMENT_CONFIRMED",
			"receipt": receipt.CantonReceipt{
				Version:                  "1.0",
				Domain:                   receipt.DomainV1,
				OrderID:                  "test-order",
				LedgerID:                 "ledger-1",
				TransactionID:            "tx-1",
				ContractID:               "cid-1",
				PaymentRequestContractID: "prcid-1",
				ParticipantPartyID:       "Participant1",
				Merchant:                 "Merch",
				Payer:                    "Alice",
				Amount:                   "1.5",
				Currency:                 "USD-canton",
				TrustedIssuer:            "Issuer1",
				Resource:                 "/resource",
				MerchantRequestID:        "req-aaaa-bbbb-cccc-dddd-1234",
				ExpiresAtHTTP:            time.Now().Add(time.Minute).UnixMilli(),
				ExpiresAtDaml:            time.Now().Add(2 * time.Minute).UnixMilli(),
				SignatureScheme:          receipt.SignatureSchemeEd25519,
				Signature:                base64.StdEncoding.EncodeToString([]byte("participantsig")),
				ReceiptPayloadHash:       "aGFzaA==",
				CompletedAt:              time.Now().UnixMilli(),
			},
		})
	})

	mux.HandleFunc("/api/v1/orders/test-order/proof", func(w http.ResponseWriter, r *http.Request) {
		if !authCheck(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(receipt.CantonReceipt{
			Version:                  "1.0",
			Domain:                   receipt.DomainV1,
			OrderID:                  "test-order",
			LedgerID:                 "ledger-1",
			TransactionID:            "tx-1",
			ContractID:               "cid-1",
			PaymentRequestContractID: "prcid-1",
			ParticipantPartyID:       "Participant1",
			Merchant:                 "Merch",
			Payer:                    "Alice",
			Amount:                   "1.5",
			Currency:                 "USD-canton",
			TrustedIssuer:            "Issuer1",
			Resource:                 "/resource",
			MerchantRequestID:        "req-aaaa-bbbb-cccc-dddd-1234",
			SignatureScheme:          receipt.SignatureSchemeEd25519,
			Signature:                base64.StdEncoding.EncodeToString([]byte("participantsig")),
		})
	})

	mux.HandleFunc("/api/v1/orders/test-order", func(w http.ResponseWriter, r *http.Request) {
		if !authCheck(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId":        "test-order",
			"status":         "PAYMENT_CONFIRMED",
			"retryState":     "healthy",
			"retryLastError": nil,
		})
	})

	return httptest.NewServer(mux)
}

// newFakeAsyncFacilitator returns a facilitator that emits 202 on
// /calldata-signature and serves PAYMENT_CONFIRMED on /orders/:id only after
// the first poll, forcing the flow to hit /orders/:id and /orders/:id/proof.
func newFakeAsyncFacilitator(t *testing.T, tracker *headerTracker, expectToken string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var polled int32

	auth := func(w http.ResponseWriter, r *http.Request) bool {
		tok := r.Header.Get("X-Payer-Token")
		tracker.record(r.Method, r.URL.Path, tok)
		if tok != expectToken {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"UNAUTHENTICATED","message":"bad token"}`))
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
			"signatureScheme": "Ed25519", "signature": "c2ln", "publicKey": "cHVi",
		})
	})
	mux.HandleFunc("/api/v1/orders/test-order/calldata-signature", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
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
		if atomic.AddInt32(&polled, 1) >= 1 {
			status = "PAYMENT_CONFIRMED"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orderId": "test-order", "status": status, "retryState": "healthy",
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
			TransactionID: "tx-async-auth",
		})
	})
	return httptest.NewServer(mux)
}

// newFakeMerchant stands up a deterministic merchant that returns 402 with a
// canton-daml entry on the first request and 200 with the body on the second
// (replay with X-PAYMENT).
func newFakeMerchant(t *testing.T, facilitatorURL string, _ *headerTracker) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/resource", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-PAYMENT") != "" {
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("protected-body"))
			return
		}
		envelope := map[string]any{
			"x402Version": 1,
			"accepts": []map[string]any{{
				"scheme":            "canton-daml",
				"amount":            "1.5",
				"currency":          "USD-canton",
				"trustedIssuer":     "Issuer1",
				"payTo":             "Merch",
				"facilitator":       facilitatorURL,
				"resource":          "/resource",
				"merchantRequestId": "req-aaaa-bbbb-cccc-dddd-1234",
			}},
			"error": "payment_required",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_ = json.NewEncoder(w).Encode(envelope)
	})
	return httptest.NewServer(mux)
}
