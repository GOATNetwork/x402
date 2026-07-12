package goatx402

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// serverSign mirrors the core HMAC scheme
// (goatx402-core/internal/api/signature.go): parse the body JSON into
// map[string]any, flatten top-level scalars (integers without scientific
// notation), add api_key/timestamp/nonce, sort non-empty params by key, join as
// "k=v&...", and HMAC-SHA256 it. This lets the test assert the SDK signs exactly
// what the server will recompute.
func serverSign(t *testing.T, bodyBytes []byte, apiKey, timestamp, nonce, secret string) string {
	t.Helper()
	params := map[string]string{}
	if len(bodyBytes) > 0 {
		var body map[string]any
		if err := json.Unmarshal(bodyBytes, &body); err != nil {
			t.Fatalf("unmarshal body: %v", err)
		}
		for k, v := range body {
			if f, ok := v.(float64); ok {
				if f == float64(int64(f)) {
					params[k] = fmt.Sprintf("%.0f", f)
				} else {
					params[k] = fmt.Sprintf("%f", f)
				}
			} else {
				params[k] = fmt.Sprintf("%v", v)
			}
		}
	}
	params["api_key"] = apiKey
	params["timestamp"] = timestamp
	params["nonce"] = nonce

	keys := make([]string, 0, len(params))
	for k := range params {
		if params[k] != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, params[k]))
	}
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(strings.Join(parts, "&")))
	return hex.EncodeToString(h.Sum(nil))
}

func TestCreateDelegateCheckoutSession(t *testing.T) {
	const apiKey = "test-key"
	const apiSecret = "test-secret"

	var gotPath, gotMethod string
	var gotHeader http.Header
	var gotBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotHeader = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"checkout_id":"h_abc","checkout_type":"DELEGATE","url":"https://pay.example.com/checkout?cs=h_abc","expires_at":1893456000}`))
	}))
	defer srv.Close()

	client := NewClient(Config{BaseURL: srv.URL, APIKey: apiKey, APISecret: apiSecret})

	// The deprecated wrapper forwards to the unified endpoint.
	res, err := client.CreateDelegateCheckoutSession(context.Background(), CreateDelegateCheckoutSessionParams{
		ChainID:           56,
		TokenContract:     "0xToken",
		AmountWei:         "1000000",
		CallbackCalldata:  "0xdeadbeef",
		SuccessURL:        "https://shop.example.com/ok",
		CancelURL:         "https://shop.example.com/cancel",
		ClientReferenceID: "ref-1",
		ExpiresIn:         1800,
	})
	if err != nil {
		t.Fatalf("CreateDelegateCheckoutSession: %v", err)
	}

	// Response mapping (checkout_id -> Handle, url, expires_at).
	if res.Handle != "h_abc" {
		t.Errorf("Handle = %q, want %q", res.Handle, "h_abc")
	}
	if res.URL != "https://pay.example.com/checkout?cs=h_abc" {
		t.Errorf("URL = %q", res.URL)
	}
	if res.ExpiresAt != 1893456000 {
		t.Errorf("ExpiresAt = %d, want 1893456000", res.ExpiresAt)
	}

	// Request shape — the wrapper hits the unified endpoint.
	if gotMethod != http.MethodPost {
		t.Errorf("method = %s, want POST", gotMethod)
	}
	if gotPath != "/api/v1/checkout/sessions" {
		t.Errorf("path = %s", gotPath)
	}

	// Body uses the unified snake_case fields; the single token is wrapped into the
	// JSON-stringified acceptable_tokens and amount_wei maps to fixed_amount_wei.
	var body map[string]any
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal sent body: %v", err)
	}
	want := map[string]any{
		"checkout_type":       "DELEGATE",
		"chain_id":            float64(56),
		"fixed_amount_wei":    "1000000",
		"callback_calldata":   "0xdeadbeef",
		"acceptable_tokens":   `["0xToken"]`,
		"success_url":         "https://shop.example.com/ok",
		"cancel_url":          "https://shop.example.com/cancel",
		"client_reference_id": "ref-1",
		"expires_in":          float64(1800),
	}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("body = %#v\nwant %#v", body, want)
	}

	// HMAC auth headers present.
	ts := gotHeader.Get("X-Timestamp")
	nonce := gotHeader.Get("X-Nonce")
	sign := gotHeader.Get("X-Sign")
	if gotHeader.Get("X-API-Key") != apiKey || ts == "" || nonce == "" || sign == "" {
		t.Fatalf("missing auth headers: key=%q ts=%q nonce=%q sign=%q",
			gotHeader.Get("X-API-Key"), ts, nonce, sign)
	}

	// X-Sign must match a server-side recomputation over the body + auth params.
	if wantSign := serverSign(t, gotBody, apiKey, ts, nonce, apiSecret); sign != wantSign {
		t.Errorf("X-Sign = %s, want %s", sign, wantSign)
	}
}

func TestCreateDelegateCheckoutSessionOmitsOptionalScalars(t *testing.T) {
	const apiKey = "k"
	const apiSecret = "s"

	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"checkout_id":"h","checkout_type":"DELEGATE","url":"u","expires_at":1}`))
	}))
	defer srv.Close()

	client := NewClient(Config{BaseURL: srv.URL, APIKey: apiKey, APISecret: apiSecret})
	if _, err := client.CreateDelegateCheckoutSession(context.Background(), CreateDelegateCheckoutSessionParams{
		ChainID:          1,
		TokenContract:    "0xT",
		AmountWei:        "5",
		CallbackCalldata: "0x01",
	}); err != nil {
		t.Fatalf("CreateDelegateCheckoutSession: %v", err)
	}

	var body map[string]any
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal sent body: %v", err)
	}
	want := map[string]any{
		"checkout_type":     "DELEGATE",
		"chain_id":          float64(1),
		"fixed_amount_wei":  "5",
		"callback_calldata": "0x01",
		"acceptable_tokens": `["0xT"]`,
	}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("body = %#v\nwant %#v", body, want)
	}
}

// TestCreateCheckoutSessionDirect covers the unified DIRECT path: only the price
// scalar is sent (no DELEGATE-only fields), and nested line_items are stringified.
func TestCreateCheckoutSessionDirect(t *testing.T) {
	const apiKey = "k"
	const apiSecret = "s"

	var gotPath string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"checkout_id":"cs_1","checkout_type":"DIRECT","url":"u","expires_at":2}`))
	}))
	defer srv.Close()

	client := NewClient(Config{BaseURL: srv.URL, APIKey: apiKey, APISecret: apiSecret})
	res, err := client.CreateCheckoutSession(context.Background(), CreateCheckoutSessionParams{
		CheckoutType: "DIRECT",
		Price:        "9.99",
		LineItems:    []any{map[string]any{"name": "Mug", "amount": "9.99"}},
	})
	if err != nil {
		t.Fatalf("CreateCheckoutSession: %v", err)
	}
	if res.CheckoutID != "cs_1" || res.CheckoutType != "DIRECT" {
		t.Errorf("res = %#v", res)
	}
	if gotPath != "/api/v1/checkout/sessions" {
		t.Errorf("path = %s", gotPath)
	}

	var body map[string]any
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal sent body: %v", err)
	}
	want := map[string]any{
		"checkout_type":   "DIRECT",
		"price":           "9.99",
		"line_items_json": `[{"amount":"9.99","name":"Mug"}]`,
	}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("body = %#v\nwant %#v", body, want)
	}
}
