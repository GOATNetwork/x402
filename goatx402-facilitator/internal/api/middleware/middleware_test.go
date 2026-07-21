package middleware_test

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
)

func noopHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

func TestRequirePayerToken_Missing(t *testing.T) {
	h := middleware.RequirePayerToken(noopHandler())
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "UNAUTHENTICATED") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestRequirePayerToken_Present(t *testing.T) {
	h := middleware.RequirePayerToken(noopHandler())
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set(middleware.HeaderXPayerToken, "abc")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestAssertBoundToParty(t *testing.T) {
	store := middleware.MapPayerTokenStore{
		"alice": []byte("alice-secret"),
	}
	good := base64.StdEncoding.EncodeToString([]byte("alice-secret"))

	ok, _ := middleware.AssertBoundToParty(good, "alice", store)
	if !ok {
		t.Fatalf("expected match")
	}
	ok, code := middleware.AssertBoundToParty(good, "bob", store)
	if ok || code != "PAYER_NOT_BOUND" {
		t.Fatalf("expected PAYER_NOT_BOUND, got %q", code)
	}
	ok, code = middleware.AssertBoundToParty("", "alice", store)
	if ok || code != "UNAUTHENTICATED" {
		t.Fatalf("expected UNAUTHENTICATED on empty token, got %q", code)
	}
	ok, _ = middleware.AssertBoundToParty("wrong", "alice", store)
	if ok {
		t.Fatalf("expected wrong token to be rejected")
	}
}

func TestCORS_PreflightAndExpose(t *testing.T) {
	mw := middleware.CORS(middleware.CORSOptions{
		AllowOrigins: []string{"http://localhost:5173"},
	})
	h := mw(noopHandler())

	// OPTIONS preflight from allowed origin.
	r := httptest.NewRequest(http.MethodOptions, "/api/v1/orders", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight expected 204, got %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("allow-origin: %q", w.Header().Get("Access-Control-Allow-Origin"))
	}
	expose := w.Header().Get("Access-Control-Expose-Headers")
	if !strings.Contains(expose, middleware.HeaderX402SupportedVersions) {
		t.Fatalf("expose-headers missing version header: %q", expose)
	}

	// GET from disallowed origin: handler still serves; CORS headers absent.
	r = httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Origin", "https://evil.example.com")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 passthrough; got %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("disallowed origin must not get CORS headers")
	}
}

func TestBodyLimit_ContentLengthRejected(t *testing.T) {
	mw := middleware.BodyLimit(16)
	h := mw(noopHandler())
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("xxxxxxxxxxxxxxxxxxxx"))
	r.ContentLength = 32
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "PAYLOAD_TOO_LARGE") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestBodyLimit_ReaderRejectsOverflow(t *testing.T) {
	mw := middleware.BodyLimit(4)
	// Echoes the body; if MaxBytesReader fires, we get a read error.
	echo := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 64)
		n, err := r.Body.Read(buf)
		if err != nil && err.Error() != "EOF" {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		_, _ = w.Write(buf[:n])
	})
	h := mw(echo)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("toolong-body"))
	r.ContentLength = -1
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 from MaxBytesReader, got %d", w.Code)
	}
}

func TestRateLimit_TokenBudget(t *testing.T) {
	now := time.Now()
	clock := &fakeClock{t: now}
	mw := middleware.RateLimit(middleware.RateLimitOptions{
		PerTokenRPS: 1,
		PerIPRPS:    1000,
		BurstToken:  2,
		BurstIP:     1000,
		IPMapMax:    100,
		Now:         clock.now,
	})
	h := mw(noopHandler())

	doReq := func(token string) int {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "1.2.3.4:1"
		if token != "" {
			r.Header.Set(middleware.HeaderXPayerToken, token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	// First 2 calls inside the burst — OK.
	if c := doReq("tok-a"); c != 200 {
		t.Fatalf("call 1: %d", c)
	}
	if c := doReq("tok-a"); c != 200 {
		t.Fatalf("call 2: %d", c)
	}
	// Third call inside the same instant — rate-limited.
	if c := doReq("tok-a"); c != http.StatusTooManyRequests {
		t.Fatalf("call 3 expected 429, got %d", c)
	}
	// Advance clock by 2 seconds; budget refills.
	clock.advance(2 * time.Second)
	if c := doReq("tok-a"); c != 200 {
		t.Fatalf("after refill: %d", c)
	}
}

func TestRateLimit_IPMapBounded(t *testing.T) {
	now := time.Now()
	clock := &fakeClock{t: now}
	mw := middleware.RateLimit(middleware.RateLimitOptions{
		PerTokenRPS: 1000,
		PerIPRPS:    1000,
		BurstToken:  1000,
		BurstIP:     1000,
		IPMapMax:    4,
		Now:         clock.now,
	})
	h := mw(noopHandler())
	// 100 distinct IPs; the LRU should keep at most 4.
	for i := 0; i < 100; i++ {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = paddedAddr(i)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("call %d: %d", i, w.Code)
		}
	}
}

func paddedAddr(i int) string {
	return "192.168.0." + itoa3(i) + ":1234"
}

func itoa3(i int) string {
	a := byte('0' + (i/100)%10)
	b := byte('0' + (i/10)%10)
	c := byte('0' + i%10)
	return string([]byte{a, b, c})
}

type fakeClock struct {
	t time.Time
}

func (f *fakeClock) now() time.Time { return f.t }
func (f *fakeClock) advance(d time.Duration) {
	f.t = f.t.Add(d)
}
