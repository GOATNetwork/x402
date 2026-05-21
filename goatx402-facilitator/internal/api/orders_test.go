package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
)

func newTestStore(t *testing.T) *store.SQLiteStore {
	t.Helper()
	s, err := store.Open(store.SQLiteOptions{})
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func newCreateOrderDeps(t *testing.T, st store.OrderStore) (api.CreateOrderDeps, string) {
	t.Helper()
	rawToken := []byte("alice-secret-32bytes-padding-here00")
	tokens := middleware.MapPayerTokenStore{"alice": rawToken}
	d := api.CreateOrderDeps{
		Store:      st,
		TokenStore: tokens,
		CurrencyAllowList: map[string]struct{}{
			"USD-canton": {},
		},
		TrustedIssuerMap:      map[string]string{"USD-canton": "issuer-party"},
		LedgerSkewSafety:      30 * time.Second,
		X402SupportedVersions: []int{1},
		Now:                   func() time.Time { return time.UnixMilli(1_715_600_000_000).UTC() },
	}
	return d, base64.StdEncoding.EncodeToString(rawToken)
}

func validBody() map[string]any {
	return map[string]any{
		"x402Version":             1,
		"merchant":                "merchant-party",
		"payer":                   "alice",
		"amount":                  "1.50",
		"currency":                "USD-canton",
		"trustedIssuer":           "issuer-party",
		"resource":                "/protected",
		"merchantRequestId":       "abcdefghijklmnopqrstuv",
		"sourceHoldingContractId": "src-cid",
		"expiresIn":               120,
	}
}

func TestCreateOrder_HappyPath(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)

	body, _ := json.Marshal(validBody())
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["status"] != "CREATED" {
		t.Fatalf("status=%v", resp["status"])
	}
	if resp["submissionPayloadHash"] == "" {
		t.Fatalf("missing submissionPayloadHash")
	}
	accepts := resp["accepts"].([]any)
	if len(accepts) != 1 {
		t.Fatalf("accepts=%v", accepts)
	}
	versions := w.Header().Get("X-X402-Supported-Versions")
	if versions != "1" {
		t.Fatalf("version header: %q", versions)
	}
	// Order persisted.
	orderID, _ := resp["orderId"].(string)
	if _, err := st.Get(context.Background(), orderID); err != nil {
		t.Fatalf("expected order persisted: %v", err)
	}
}

func TestCreateOrder_RejectsUnknownCurrency(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	b := validBody()
	b["currency"] = "EUR-canton"
	body, _ := json.Marshal(b)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400; got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "INVALID_INPUT") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestCreateOrder_RejectsTrustedIssuerMismatch(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	b := validBody()
	b["trustedIssuer"] = "other-issuer"
	body, _ := json.Marshal(b)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400; got %d", w.Code)
	}
}

func TestCreateOrder_RejectsMissingPayerToken(t *testing.T) {
	st := newTestStore(t)
	d, _ := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401; got %d", w.Code)
	}
}

func TestCreateOrder_RejectsWrongPayerBinding(t *testing.T) {
	st := newTestStore(t)
	d, _ := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	// Wrong token (does not decode to alice-secret).
	r.Header.Set("X-Payer-Token", base64.StdEncoding.EncodeToString([]byte("not-alice")))
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403; got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "PAYER_NOT_BOUND") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestCreateOrder_RejectsBadMerchantRequestID(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	b := validBody()
	b["merchantRequestId"] = "tooshort"
	body, _ := json.Marshal(b)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400; got %d", w.Code)
	}
}

func TestCreateOrder_RejectsUnsupportedVersion(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	b := validBody()
	b["x402Version"] = 99
	body, _ := json.Marshal(b)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400; got %d", w.Code)
	}
}

func TestCreateOrder_NormalisesAmount(t *testing.T) {
	got, err := api.NormaliseAmount("1.50")
	if err != nil {
		t.Fatalf("normalise 1.50: %v", err)
	}
	if got != "1.5" {
		t.Fatalf("normalise: %q", got)
	}
	if _, err := api.NormaliseAmount("01.5"); err == nil {
		t.Fatalf("expected reject leading zero")
	}
	if _, err := api.NormaliseAmount("1e1"); err == nil {
		t.Fatalf("expected reject exponent form")
	}
	if _, err := api.NormaliseAmount("0.0"); err == nil {
		t.Fatalf("expected reject zero amount")
	}
	if _, err := api.NormaliseAmount("1.12345678901"); err == nil {
		t.Fatalf("expected reject excess fractional digits")
	}
}

func TestCanonicalDedupInput_DeterministicAndDistinct(t *testing.T) {
	in1 := api.DedupInput{
		Payer: "alice", Merchant: "m", Amount: "1.5", Currency: "USD-canton",
		TrustedIssuer: "iss", ExpiresAtHTTP: 1, Resource: "/r",
		SourceHoldingContractID: "cid", MerchantRequestID: "mreq",
		OrderID: "ord", Nonce: "n",
	}
	a, _ := api.CanonicalDedupInput(in1)
	b, _ := api.CanonicalDedupInput(in1)
	if !bytes.Equal(a, b) {
		t.Fatalf("CanonicalDedupInput not deterministic")
	}
	in2 := in1
	in2.Nonce = "different"
	c, _ := api.CanonicalDedupInput(in2)
	if bytes.Equal(a, c) {
		t.Fatalf("expected distinct outputs for distinct nonces")
	}
}

func TestCanonicalSubmission_IncludesDedupKey(t *testing.T) {
	common := api.SignInput{
		Payer: "alice", Merchant: "m", Amount: "1.5", Currency: "USD-canton",
		TrustedIssuer: "iss", ExpiresAtHTTP: 1, Resource: "/r",
		SourceHoldingContractID: "cid", MerchantRequestID: "mreq",
		OrderID: "ord", Nonce: "n", DedupKey: "k1",
	}
	a, _ := api.CanonicalSubmission(common)
	b := common
	b.DedupKey = "k2"
	c, _ := api.CanonicalSubmission(b)
	if bytes.Equal(a, c) {
		t.Fatalf("CanonicalSubmission must include dedupKey")
	}
}

func TestCreateOrder_DuplicateClientRequest(t *testing.T) {
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	b := validBody()
	b["clientRequestId"] = "idem-1"
	body, _ := json.Marshal(b)
	first := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(first, mustReq(token, body))
	if first.Code != http.StatusCreated {
		t.Fatalf("first call: %d body=%s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(second, mustReq(token, body))
	if second.Code != http.StatusConflict {
		t.Fatalf("second call: expected 409, got %d body=%s", second.Code, second.Body.String())
	}
	if !strings.Contains(second.Body.String(), "DUPLICATE_CLIENT_REQUEST") {
		t.Fatalf("body=%s", second.Body.String())
	}
}

func mustReq(token string, body []byte) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	return r
}
