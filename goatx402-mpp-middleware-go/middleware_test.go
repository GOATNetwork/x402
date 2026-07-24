package mppmiddleware

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

// fixedClock returns t whenever called. Wraps time.Now for tests.
func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// validReceipt returns a Receipt that passes receiptspec.Validate AND
// is bound to the test's expected merchant/route. The issuedAt is
// chosen so that the default "now" used by tests (issuedAt + 1m) is
// well inside the validity window.
func validReceipt(merchantID, routeCanonical string) receiptspec.Receipt {
	issued := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	r := receiptspec.Receipt{
		ReceiptID:        "rcpt_test_abc",
		ChallengeID:      "chal_xyz",
		OrderID:          "order_1",
		MerchantID:       merchantID,
		PayerAddr:        "0x1111111111111111111111111111111111111111",
		ChainID:          1,
		TokenContract:    "0x2222222222222222222222222222222222222222",
		Recipient:        "0x3333333333333333333333333333333333333333",
		AmountWei:        "1000000",
		RequestCanonical: routeCanonical,
		TxHash:           "0xdeadbeef",
		LogIndex:         42,
		BlockNumber:      18000000,
		BlockTimestamp:   issued,
		ReceiptIssuedAt:  issued,
		ReceiptExpiresAt: issued.Add(24 * time.Hour),
	}
	return r
}

// signedHeaderEd25519 builds an EncodeHeader value for r signed under
// priv. Fatal-errors the test on any encoding failure.
func signedHeaderEd25519(t *testing.T, r receiptspec.Receipt, priv ed25519.PrivateKey) string {
	t.Helper()
	sig := testSignEd25519(priv, r)
	hdr, err := receiptspec.EncodeHeader(r, sig, receiptspec.AlgEd25519)
	if err != nil {
		t.Fatalf("EncodeHeader: %v", err)
	}
	return hdr
}

// signedHeaderHMAC builds an EncodeHeader value for r signed with
// secret under HMAC-SHA256.
func signedHeaderHMAC(t *testing.T, r receiptspec.Receipt, secret []byte) string {
	t.Helper()
	sig := testSignHMAC(secret, r)
	hdr, err := receiptspec.EncodeHeader(r, sig, receiptspec.AlgHMACSHA256)
	if err != nil {
		t.Fatalf("EncodeHeader: %v", err)
	}
	return hdr
}

// observingHandler records whether it was invoked and stashes the
// receipt it observed via FromContext. Used to assert pass-through
// semantics on the happy path and short-circuit semantics on rejection.
type observingHandler struct {
	called   atomic.Bool
	receipt  receiptspec.Receipt
	receipt2 atomic.Pointer[receiptspec.Receipt]
}

func (h *observingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.called.Store(true)
	if rcpt, ok := FromContext(r.Context()); ok {
		h.receipt = rcpt
		h.receipt2.Store(&rcpt)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func TestMiddleware_HappyPath_Ed25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "merch_1"
	const route = "GET:/api/data"
	r := validReceipt(merchant, route)
	hdr := signedHeaderEd25519(t, r, priv)

	now := r.ReceiptIssuedAt.Add(time.Minute)
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
	})(next)

	req := httptest.NewRequest("GET", "/api/data", nil)
	req.Header.Set(HeaderName, hdr)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !next.called.Load() {
		t.Fatal("next handler was not invoked on the happy path")
	}
	if next.receipt.ReceiptID != r.ReceiptID {
		t.Fatalf("FromContext returned wrong receipt: got %q want %q", next.receipt.ReceiptID, r.ReceiptID)
	}
}

func TestMiddleware_HappyPath_HMAC(t *testing.T) {
	secret := []byte("a-strong-shared-secret-of-32-bytes!!")
	const merchant = "merch_42"
	const route = "POST:/v1/checkout"
	r := validReceipt(merchant, route)
	hdr := signedHeaderHMAC(t, r, secret)

	now := r.ReceiptIssuedAt.Add(time.Minute)
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgHMACSHA256,
		HMACSecret:     secret,
		Clock:          fixedClock(now),
	})(next)

	req := httptest.NewRequest("POST", "/v1/checkout", nil)
	req.Header.Set(HeaderName, hdr)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !next.called.Load() {
		t.Fatal("next handler was not invoked on the happy path")
	}
}

func TestMiddleware_RoutePrefixBinding(t *testing.T) {
	// A receipt whose request_canonical is "<route>:<extra>" must be
	// accepted by a middleware configured for "<route>".
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "m"
	const route = "GET:/api/data"
	r := validReceipt(merchant, route+":id=42")
	hdr := signedHeaderEd25519(t, r, priv)
	now := r.ReceiptIssuedAt.Add(time.Minute)
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
	})(next)

	req := httptest.NewRequest("GET", "/api/data?id=42", nil)
	req.Header.Set(HeaderName, hdr)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("prefix binding should pass, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !next.called.Load() {
		t.Fatal("next handler should run on prefix binding")
	}
}

func TestMiddleware_PrefixConfusionRejected(t *testing.T) {
	// A receipt for "GET:/api/data" must NOT satisfy a route of
	// "GET:/api" — strings.HasPrefix without the trailing colon would
	// accept this, which is the bug the colon-separator defends
	// against.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	r := validReceipt("m", "GET:/api/data")
	hdr := signedHeaderEd25519(t, r, priv)
	now := r.ReceiptIssuedAt.Add(time.Minute)
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     "m",
		RouteCanonical: "GET:/api",
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
	})(next)

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set(HeaderName, hdr)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402 route_mismatch, got %d", w.Code)
	}
	if next.called.Load() {
		t.Fatal("next handler must NOT run on route_mismatch")
	}
	if got := decodeProblem(t, w).Error; got != ReasonRouteMismatch {
		t.Fatalf("expected reason %q, got %q", ReasonRouteMismatch, got)
	}
}

// decodeProblem decodes the problem-details JSON body produced by
// writeProblem. Test helper.
func decodeProblem(t *testing.T, w *httptest.ResponseRecorder) problemDetails {
	t.Helper()
	var p problemDetails
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem details: %v (body=%s)", err, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("expected application/problem+json content-type, got %q", ct)
	}
	return p
}

// runReject builds a middleware + request scenario and asserts the
// expected status code and reason. Test helper consumed by the
// table-driven rejection-coverage test.
func runReject(t *testing.T, name string, mutate func(*Config, *http.Request, *receiptspec.Receipt), expectStatus int, expectReason string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "merch_x"
	const route = "GET:/r"
	r := validReceipt(merchant, route)
	now := r.ReceiptIssuedAt.Add(time.Minute)

	cfg := Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
	}

	// Default: build a valid header. Mutators may overwrite below.
	hdr := signedHeaderEd25519(t, r, priv)
	req := httptest.NewRequest("GET", "/r", nil)
	req.Header.Set(HeaderName, hdr)

	// Capture mutated receipt for re-signing scenarios.
	mr := r
	mutate(&cfg, req, &mr)

	// If the mutator changed mr.* (the receipt fields), re-sign and
	// rewrite the header — this lets mutators express "tamper the
	// receipt body without invalidating the signature" by NOT touching
	// mr, OR express "use a fresh valid receipt with different
	// claims" by mutating mr (the helper signs the mutated copy).
	if !receiptEqual(mr, r) {
		newHdr := signedHeaderEd25519(t, mr, priv)
		req.Header.Set(HeaderName, newHdr)
	}

	next := &observingHandler{}
	mw := Middleware(cfg)(next)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)

	if w.Code != expectStatus {
		t.Fatalf("%s: expected status %d, got %d (body=%s)", name, expectStatus, w.Code, w.Body.String())
	}
	if next.called.Load() {
		t.Fatalf("%s: next handler must not run on rejection", name)
	}
	if got := decodeProblem(t, w).Error; got != expectReason {
		t.Fatalf("%s: expected reason %q, got %q", name, expectReason, got)
	}
}

// receiptEqual compares two receipts field-by-field. We avoid
// reflect.DeepEqual to keep the dependency surface minimal and the
// failure mode obvious.
func receiptEqual(a, b receiptspec.Receipt) bool {
	return a.ReceiptID == b.ReceiptID &&
		a.ChallengeID == b.ChallengeID &&
		a.OrderID == b.OrderID &&
		a.MerchantID == b.MerchantID &&
		a.PayerAddr == b.PayerAddr &&
		a.ChainID == b.ChainID &&
		a.TokenContract == b.TokenContract &&
		a.Recipient == b.Recipient &&
		a.AmountWei == b.AmountWei &&
		a.RequestCanonical == b.RequestCanonical &&
		a.TxHash == b.TxHash &&
		a.LogIndex == b.LogIndex &&
		a.BlockNumber == b.BlockNumber &&
		a.BlockTimestamp.Equal(b.BlockTimestamp) &&
		a.ReceiptIssuedAt.Equal(b.ReceiptIssuedAt) &&
		a.ReceiptExpiresAt.Equal(b.ReceiptExpiresAt)
}

func TestMiddleware_AllRejectionPaths(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config, *http.Request, *receiptspec.Receipt)
		status int
		reason string
	}{
		{
			name:   "missing header -> 401 payment_required",
			mutate: func(_ *Config, req *http.Request, _ *receiptspec.Receipt) { req.Header.Del(HeaderName) },
			status: http.StatusUnauthorized,
			reason: ReasonPaymentRequired,
		},
		{
			name: "malformed header -> 401 invalid_payment_receipt",
			mutate: func(_ *Config, req *http.Request, _ *receiptspec.Receipt) {
				req.Header.Set(HeaderName, "not.a.valid_header")
			},
			status: http.StatusUnauthorized,
			reason: ReasonInvalidPaymentReceipt,
		},
		{
			name: "duplicate header -> 401 invalid_payment_receipt",
			mutate: func(_ *Config, req *http.Request, _ *receiptspec.Receipt) {
				req.Header.Add(HeaderName, req.Header.Get(HeaderName))
			},
			status: http.StatusUnauthorized,
			reason: ReasonInvalidPaymentReceipt,
		},
		{
			name: "wrong-algorithm tail -> 401 invalid_signature",
			mutate: func(_ *Config, req *http.Request, _ *receiptspec.Receipt) {
				hdr := req.Header.Get(HeaderName)
				// Swap the algorithm tail to hmac-sha256. Signature
				// bytes are unchanged (still ed25519 64 bytes) so
				// the verifier should treat this as an invalid sig
				// rather than a malformed header.
				parts := strings.Split(hdr, ".")
				if len(parts) != 3 {
					t.Fatalf("setup: expected 3 header parts")
				}
				parts[2] = string(receiptspec.AlgHMACSHA256)
				req.Header.Set(HeaderName, strings.Join(parts, "."))
			},
			status: http.StatusUnauthorized,
			reason: ReasonInvalidSignature,
		},
		{
			name: "bit-flipped signature -> 401 invalid_signature",
			mutate: func(_ *Config, req *http.Request, _ *receiptspec.Receipt) {
				hdr := req.Header.Get(HeaderName)
				parts := strings.Split(hdr, ".")
				// Twiddle the FIRST base64url char of the sig part.
				// The last base64url char only carries partial bits
				// (sig is 64 bytes -> 86 base64url chars with 4 bits
				// of slack in the trailing char), so a "flip last
				// char" mutation can decode to the same signature
				// bytes. Mutating the leading character guarantees
				// a real byte-level change.
				if len(parts[1]) == 0 {
					t.Fatalf("setup: empty sig part")
				}
				first := parts[1][0]
				var swap byte = 'A'
				if first == 'A' {
					swap = 'B'
				}
				parts[1] = string(swap) + parts[1][1:]
				req.Header.Set(HeaderName, strings.Join(parts, "."))
			},
			status: http.StatusUnauthorized,
			reason: ReasonInvalidSignature,
		},
		{
			name:   "audience_mismatch -> 401",
			mutate: func(_ *Config, _ *http.Request, r *receiptspec.Receipt) { r.MerchantID = "merch_OTHER" },
			status: http.StatusUnauthorized,
			reason: ReasonAudienceMismatch,
		},
		{
			name:   "route_mismatch -> 402",
			mutate: func(_ *Config, _ *http.Request, r *receiptspec.Receipt) { r.RequestCanonical = "GET:/other" },
			status: http.StatusPaymentRequired,
			reason: ReasonRouteMismatch,
		},
		{
			name: "receipt_expired -> 402",
			mutate: func(cfg *Config, _ *http.Request, r *receiptspec.Receipt) {
				// Move now past expires_at by overriding the clock.
				cfg.Clock = fixedClock(r.ReceiptExpiresAt.Add(time.Second))
			},
			status: http.StatusPaymentRequired,
			reason: ReasonReceiptExpired,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			runReject(t, tc.name, tc.mutate, tc.status, tc.reason)
		})
	}
}

// mapReceiptStore is an in-memory ReceiptIDStore for tests. NOT
// production-grade (no cross-replica atomicity).
type mapReceiptStore struct {
	mu     sync.Mutex
	seen   map[string]struct{}
	failOn string // when non-empty, MarkConsumed returns this error for any receiptID
}

func (s *mapReceiptStore) MarkConsumed(_ context.Context, id string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failOn != "" {
		return false, errors.New(s.failOn)
	}
	if _, ok := s.seen[id]; ok {
		return false, nil
	}
	if s.seen == nil {
		s.seen = make(map[string]struct{})
	}
	s.seen[id] = struct{}{}
	return true, nil
}

func TestMiddleware_ReceiptIDStore_DoubleSpend(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "m"
	const route = "GET:/r"
	r := validReceipt(merchant, route)
	hdr := signedHeaderEd25519(t, r, priv)
	now := r.ReceiptIssuedAt.Add(time.Minute)
	store := &mapReceiptStore{}
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
		ReceiptIDStore: store,
	})(next)

	// First presentation: 200.
	req1 := httptest.NewRequest("GET", "/r", nil)
	req1.Header.Set(HeaderName, hdr)
	w1 := httptest.NewRecorder()
	mw.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("first presentation: expected 200, got %d", w1.Code)
	}

	// Second presentation: 401 receipt_already_consumed.
	req2 := httptest.NewRequest("GET", "/r", nil)
	req2.Header.Set(HeaderName, hdr)
	w2 := httptest.NewRecorder()
	mw.ServeHTTP(w2, req2)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("second presentation: expected 401, got %d", w2.Code)
	}
	if got := decodeProblem(t, w2).Error; got != ReasonReceiptAlreadyConsumed {
		t.Fatalf("second presentation: expected reason %q, got %q", ReasonReceiptAlreadyConsumed, got)
	}
}

func TestMiddleware_ReceiptIDStore_BackendFailure(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "m"
	const route = "GET:/r"
	r := validReceipt(merchant, route)
	hdr := signedHeaderEd25519(t, r, priv)
	now := r.ReceiptIssuedAt.Add(time.Minute)
	store := &mapReceiptStore{failOn: "redis down"}
	next := &observingHandler{}
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
		ReceiptIDStore: store,
	})(next)

	req := httptest.NewRequest("GET", "/r", nil)
	req.Header.Set(HeaderName, hdr)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 on store backend failure, got %d", w.Code)
	}
	if got := decodeProblem(t, w).Error; got != ReasonReceiptStoreUnavailable {
		t.Fatalf("expected reason %q, got %q", ReasonReceiptStoreUnavailable, got)
	}
}

func TestMiddleware_OnReject_Invoked(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var captured atomic.Value
	mw := Middleware(Config{
		MerchantID:     "m",
		RouteCanonical: "GET:/r",
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		OnReject: func(_ *http.Request, reason string) {
			captured.Store(reason)
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("next must not run when rejected")
	}))

	req := httptest.NewRequest("GET", "/r", nil) // no Payment-Receipt header
	mw.ServeHTTP(httptest.NewRecorder(), req)

	got, _ := captured.Load().(string)
	if got != ReasonPaymentRequired {
		t.Fatalf("OnReject captured wrong reason: got %q want %q", got, ReasonPaymentRequired)
	}
}

func TestMiddleware_Concurrent(t *testing.T) {
	// Stress the middleware with many parallel valid requests. The
	// -race detector should not flag anything; the request count
	// should match the next-handler invocation count.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "m"
	const route = "GET:/r"
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).Add(time.Minute)
	store := &mapReceiptStore{}
	var counter atomic.Int64
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := FromContext(r.Context()); !ok {
			t.Errorf("FromContext returned !ok inside next handler")
		}
		counter.Add(1)
		w.WriteHeader(http.StatusOK)
	})
	mw := Middleware(Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          fixedClock(now),
		ReceiptIDStore: store,
	})(next)

	const N = 100
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		i := i
		go func() {
			defer wg.Done()
			// Distinct receipt_id per request so the store does not
			// reject as double-spend. We craft this by varying the
			// LogIndex (one of the receipt-id inputs).
			r := validReceipt(merchant, route)
			r.LogIndex = uint(i)
			// Re-derive ReceiptID so we don't accidentally collide
			// across iterations.
			r.ReceiptID = testDeriveReceiptID(r.ChallengeID, r.OrderID, r.TxHash, r.LogIndex)
			hdr := signedHeaderEd25519(t, r, priv)
			req := httptest.NewRequest("GET", "/r", nil)
			req.Header.Set(HeaderName, hdr)
			w := httptest.NewRecorder()
			mw.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("concurrent request %d: expected 200, got %d", i, w.Code)
			}
		}()
	}
	wg.Wait()
	if got := counter.Load(); got != N {
		t.Fatalf("expected %d successful invocations, got %d", N, got)
	}
}

func TestFromContext_NoReceipt(t *testing.T) {
	_, ok := FromContext(context.Background())
	if ok {
		t.Fatal("FromContext on a bare context must return !ok")
	}
}

func TestMiddleware_PanicsOnBadConfig(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{name: "empty MerchantID", cfg: Config{RouteCanonical: "r", Algorithm: receiptspec.AlgEd25519, Ed25519Public: make([]byte, ed25519.PublicKeySize)}},
		{name: "empty RouteCanonical", cfg: Config{MerchantID: "m", Algorithm: receiptspec.AlgEd25519, Ed25519Public: make([]byte, ed25519.PublicKeySize)}},
		{name: "unknown algorithm", cfg: Config{MerchantID: "m", RouteCanonical: "r", Algorithm: "nope"}},
		{name: "ed25519 wrong key length", cfg: Config{MerchantID: "m", RouteCanonical: "r", Algorithm: receiptspec.AlgEd25519, Ed25519Public: []byte{0x01}}},
		{name: "hmac empty secret", cfg: Config{MerchantID: "m", RouteCanonical: "r", Algorithm: receiptspec.AlgHMACSHA256}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected Middleware to panic on %s", tc.name)
				}
			}()
			_ = Middleware(tc.cfg)
		})
	}
}

func TestVerify_CrossValidation_HelpersFromReceiptSpec(t *testing.T) {
	// Sanity: build a receipt using the local test issuance helpers
	// (testDeriveReceiptID, testSignEd25519) plus receiptspec.EncodeHeader
	// and feed it
	// through verify(). This pins that the middleware contract still
	// matches the spec contract — any drift here breaks cross-module
	// interop.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const merchant = "xcheck-m"
	const route = "GET:/x"
	r := validReceipt(merchant, route)
	r.LogIndex = 7
	r.ReceiptID = testDeriveReceiptID(r.ChallengeID, r.OrderID, r.TxHash, r.LogIndex)
	if err := r.Validate(); err != nil {
		t.Fatalf("validReceipt fixture should validate: %v", err)
	}
	hdr := signedHeaderEd25519(t, r, priv)

	cfg := Config{
		MerchantID:     merchant,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
	}
	now := r.ReceiptIssuedAt.Add(time.Minute)
	res := verify(cfg, hdr, now)
	if res.Status != 0 || res.Reason != "" {
		t.Fatalf("cross-validation verify failed: status=%d reason=%q", res.Status, res.Reason)
	}
	if res.Receipt.ReceiptID != r.ReceiptID {
		t.Fatalf("decoded receipt id mismatch: got %q want %q", res.Receipt.ReceiptID, r.ReceiptID)
	}
}

// Ensure the package-level error sentinel can be matched by errors.Is.
// Currently ErrMissingHeader is informational; this guard ensures it
// remains errors-package-compatible if future code paths surface it.
func TestErrMissingHeader_IsError(t *testing.T) {
	if !errors.Is(ErrMissingHeader, ErrMissingHeader) {
		t.Fatal("ErrMissingHeader should match itself under errors.Is")
	}
}

// Sanity demo: confirm the rejection-reason constants are exported as
// strings and stable (catching typos in renames). The exact string
// values are part of the API surface.
func TestRejectionReasonConstantsStable(t *testing.T) {
	cases := map[string]string{
		ReasonPaymentRequired:         "payment_required",
		ReasonInvalidPaymentReceipt:   "invalid_payment_receipt",
		ReasonInvalidSignature:        "invalid_signature",
		ReasonAudienceMismatch:        "audience_mismatch",
		ReasonRouteMismatch:           "route_mismatch",
		ReasonReceiptExpired:          "receipt_expired",
		ReasonReceiptAlreadyConsumed:  "receipt_already_consumed",
		ReasonReceiptStoreUnavailable: "receipt_store_unavailable",
	}
	for got, want := range cases {
		if got != want {
			t.Fatalf("rejection reason drift: got %q, want %q", got, want)
		}
	}
}

// Belt-and-braces: build a fake handler-chain that ALSO writes a
// response after the middleware rejects, and assert the middleware
// terminated the chain. Catches regressions where someone forgets the
// "return" after writeProblem.
func TestMiddleware_ChainShortCircuitsOnReject(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var nextRan atomic.Bool
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextRan.Store(true)
		// If middleware forgot to return, this 500 would land on top
		// of the 401 problem body.
		w.WriteHeader(http.StatusInternalServerError)
	})
	mw := Middleware(Config{
		MerchantID:     "m",
		RouteCanonical: "GET:/r",
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
	})(next)
	req := httptest.NewRequest("GET", "/r", nil)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)
	if nextRan.Load() {
		t.Fatal("next handler ran after middleware rejection")
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

// Stringer-style guard: ensure problemDetails JSON encodes the fields
// we documented. A silent rename of the JSON tag would break merchant
// log alerting that keys on the "error" field.
func TestProblemDetailsJSONShape(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	mw := Middleware(Config{
		MerchantID:     "m",
		RouteCanonical: "GET:/r",
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	req := httptest.NewRequest("GET", "/r", nil)
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, req)
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("body not JSON: %v (body=%s)", err, w.Body.String())
	}
	for _, key := range []string{"type", "title", "status", "error"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("problem details body missing required key %q (body=%s)", key, w.Body.String())
		}
	}
}
