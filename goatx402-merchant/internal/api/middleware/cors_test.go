package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/goatnetwork/goatx402-merchant/internal/api/middleware"
)

func newHandler(cfg middleware.CORSConfig) http.Handler {
	mw := middleware.CORS(cfg)
	return mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
}

func TestCORS_PreflightFromAllowedOrigin(t *testing.T) {
	h := newHandler(middleware.CORSConfig{AllowedOrigins: []string{"http://localhost:5173"}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/resource", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight: want 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Allow-Origin: want allowlisted echo, got %q", got)
	}
	// PLAN.md §5.5 mandates X-X402-Supported-Versions is exposed so the
	// browser SDK can read it (the Sec-* unreadable-header workaround).
	if got := rec.Header().Get("Access-Control-Expose-Headers"); got != "X-X402-Supported-Versions" {
		t.Fatalf("Expose-Headers: want X-X402-Supported-Versions, got %q", got)
	}
}

func TestCORS_PreflightFromDisallowedOrigin(t *testing.T) {
	h := newHandler(middleware.CORSConfig{AllowedOrigins: []string{"http://allowed.example"}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/resource", nil)
	req.Header.Set("Origin", "http://attacker.example")
	h.ServeHTTP(rec, req)

	// Preflight still 204 (RFC-friendly), but no Allow-Origin so the browser
	// will block the actual fetch.
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight: want 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin: want empty for disallowed origin, got %q", got)
	}
}

func TestCORS_NoOriginPassesThrough(t *testing.T) {
	h := newHandler(middleware.CORSConfig{AllowedOrigins: []string{"http://localhost:5173"}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/resource", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("no-origin GET: want 200, got %d", rec.Code)
	}
}

func TestCORS_AllowedOriginOnRealRequest(t *testing.T) {
	h := newHandler(middleware.CORSConfig{AllowedOrigins: []string{"http://localhost:5173"}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/resource", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Allow-Origin echo: got %q", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("Vary: want Origin, got %q", got)
	}
}
