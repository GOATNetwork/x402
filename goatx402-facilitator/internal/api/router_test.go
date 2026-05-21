package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
)

func newRouter(t *testing.T) (http.Handler, string) {
	t.Helper()
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	d := api.RouterDeps{
		CreateOrder: create,
		Health:      api.HealthDeps{},
		CORSOpts:    middleware.CORSOptions{AllowOrigins: []string{"http://localhost:5173"}},
		BodyLimit:   32 * 1024,
		RateLimit: middleware.RateLimitOptions{
			PerTokenRPS: 1000,
			PerIPRPS:    1000,
			BurstToken:  1000,
			BurstIP:     1000,
			IPMapMax:    100,
		},
		Status: api.StatusDeps{Store: st, TokenStore: create.TokenStore},
		Proof:  api.ProofDeps{Store: st, Receipts: &stubReceiptReader{}, TokenStore: create.TokenStore},
	}
	return api.NewRouter(d), token
}

func TestRouter_HealthEndpoints(t *testing.T) {
	h, _ := newRouter(t)
	for _, path := range []string{"/healthz", "/readyz"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d body=%s", path, w.Code, w.Body.String())
		}
	}
}

func TestRouter_CreateOrderRoutedAndAuthed(t *testing.T) {
	h, token := newRouter(t)
	body, _ := json.Marshal(validBody())
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.Header.Set("X-Payer-Token", token)
	r.RemoteAddr = "1.2.3.4:1111"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestRouter_CreateOrderRequiresToken(t *testing.T) {
	h, _ := newRouter(t)
	body, _ := json.Marshal(validBody())
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(body))
	r.RemoteAddr = "1.2.3.4:1111"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestRouter_OPTIONSPreflight(t *testing.T) {
	h, _ := newRouter(t)
	r := httptest.NewRequest(http.MethodOptions, "/api/v1/orders", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.RemoteAddr = "1.2.3.4:1111"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("missing CORS origin header")
	}
	if !strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), middleware.HeaderX402SupportedVersions) {
		t.Fatalf("missing expose-headers: %q", w.Header().Get("Access-Control-Expose-Headers"))
	}
}

func TestRouter_BodyLimitReturns413(t *testing.T) {
	h, token := newRouter(t)
	tooBig := bytes.Repeat([]byte("x"), 32*1024+1)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewReader(tooBig))
	r.Header.Set("X-Payer-Token", token)
	r.ContentLength = int64(len(tooBig))
	r.RemoteAddr = "1.2.3.4:1111"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d body=%s", w.Code, w.Body.String())
	}
}
