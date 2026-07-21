package api_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/api"
	"github.com/goatnetwork/goatx402-merchant/internal/replay"
	"github.com/goatnetwork/goatx402-receipt"
)

// fixedClock anchors a deterministic "now" for receipt freshness tests.
var fixedClock = time.UnixMilli(1_715_600_005_000)

const (
	merchantParty = "Merchant::1220abc"
	payerParty    = "Payer::1220abc"
	issuerParty   = "Issuer::1220abc"
	amountStr     = "1.5"
	currencyStr   = "USD-canton"
	resourcePath  = "/resource"
)

func newKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey: %v", err)
	}
	return pub, priv
}

// baseReceipt is the canonical "good" receipt. Tests mutate fields then
// re-sign to produce the tamper-matrix variants.
func baseReceipt(nonce string) receipt.CantonReceipt {
	return receipt.CantonReceipt{
		Version:                  receipt.SchemaVersion,
		Domain:                   receipt.DomainV1,
		OrderID:                  "0190f7d2-1234-7890-abcd-1234567890ab",
		LedgerID:                 "participant-localnet",
		TransactionID:            "tx-deadbeef-0001",
		ContractID:               "00:Holding:merchant-001",
		PaymentRequestContractID: "00:PaymentRequest:0001",
		ParticipantPartyID:       "participant::1220abc",
		Merchant:                 merchantParty,
		Payer:                    payerParty,
		Amount:                   amountStr,
		Currency:                 currencyStr,
		TrustedIssuer:            issuerParty,
		Resource:                 resourcePath,
		MerchantRequestID:        nonce,
		ExpiresAtHTTP:            1_715_600_000_000,
		ExpiresAtDaml:            1_715_600_030_000,
		SignatureScheme:          receipt.SignatureSchemeEd25519,
		CompletedAt:              fixedClock.Add(-3 * time.Second).UnixMilli(),
	}
}

func sign(t *testing.T, priv ed25519.PrivateKey, r receipt.CantonReceipt) receipt.CantonReceipt {
	t.Helper()
	canonical, err := r.Canonical()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	sig := ed25519.Sign(priv, canonical)
	digest := sha256.Sum256(canonical)
	r.Signature = base64.StdEncoding.EncodeToString(sig)
	r.ReceiptPayloadHash = base64.StdEncoding.EncodeToString(digest[:])
	return r
}

func encodeReceipt(t *testing.T, r receipt.CantonReceipt) string {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal receipt: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// testHarness wires a Resource + Verifier with deterministic clocks and a
// generous rate-limit. Individual tests adjust knobs before issuing the
// 402 and replaying the receipt.
type testHarness struct {
	pub       ed25519.PublicKey
	priv      ed25519.PrivateKey
	resource  *api.Resource
	issuance  *replay.IssuedNonces
	replayCh  *replay.ReceiptReplay
	clock     *fakeClock
	rateLimit float64
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newHarness(t *testing.T) *testHarness {
	t.Helper()
	pub, priv := newKeypair(t)
	clk := &fakeClock{now: fixedClock}
	issuance := replay.NewIssuedNonces(10_000, 10*time.Minute, clk.Now)
	replayCache := replay.NewReceiptReplay(10_000)

	verifier := &api.Verifier{
		MaxAge:        5 * time.Minute,
		MaxClockSkew:  30 * time.Second,
		ParticipantPK: pub,
		Expected: replay.ChallengeTuple{
			Merchant:      merchantParty,
			Resource:      resourcePath,
			Amount:        amountStr,
			Currency:      currencyStr,
			TrustedIssuer: issuerParty,
		},
		Issuance:    issuance,
		ReplayCache: replayCache,
		Now:         clk.Now,
	}

	res := &api.Resource{
		MerchantPartyID: merchantParty,
		ResourcePath:    resourcePath,
		Amount:          amountStr,
		Currency:        currencyStr,
		TrustedIssuer:   issuerParty,
		FacilitatorURL:  "http://localhost:8080",
		ReceiptMaxBytes: 8 * 1024,
		Verifier:        verifier,
		Issuance:        issuance,
		Body:            []byte("unlocked"),
		Now:             clk.Now,
	}
	return &testHarness{
		pub: pub, priv: priv,
		resource: res, issuance: issuance, replayCh: replayCache,
		clock:     clk,
		rateLimit: 1000,
	}
}

// newRouter builds a handler with a configurable rate-limit. Tests that
// want to exercise 429 pass rate=1, burst=1.
func (h *testHarness) newRouter(rps float64, burst int) http.Handler {
	return api.NewRouter(api.RouterDeps{
		Resource:       h.resource,
		ResourceURL:    resourcePath,
		CORSOrigins:    []string{"http://localhost:5173"},
		RateLimitRPS:   rps,
		RateLimitBurst: burst,
		Now:            h.clock.Now,
	})
}

// requestWith402 hits the merchant once to receive a nonce + 402 envelope.
func (h *testHarness) requestWith402(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, resourcePath, nil)
	req.RemoteAddr = "127.0.0.1:12345"
	h.newRouter(h.rateLimit, int(h.rateLimit)).ServeHTTP(rec, req)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var env struct {
		Accepts []struct {
			MerchantRequestID string `json:"merchantRequestId"`
		} `json:"accepts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode 402 envelope: %v", err)
	}
	if len(env.Accepts) == 0 || env.Accepts[0].MerchantRequestID == "" {
		t.Fatalf("merchantRequestId missing from 402 envelope")
	}
	return env.Accepts[0].MerchantRequestID
}

// request hits /resource with X-PAYMENT, returning (status, body, headers).
func (h *testHarness) request(t *testing.T, method, payment string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, resourcePath, nil)
	req.RemoteAddr = "127.0.0.1:12345"
	if payment != "" {
		req.Header.Set("X-PAYMENT", payment)
	}
	h.newRouter(h.rateLimit, int(h.rateLimit)).ServeHTTP(rec, req)
	return rec
}

func TestResource_NoPaymentReturns402(t *testing.T) {
	h := newHarness(t)
	rec := h.request(t, http.MethodGet, "")
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("want 402, got %d", rec.Code)
	}
	if got := rec.Header().Get("X-X402-Supported-Versions"); got != "1" {
		t.Fatalf("X-X402-Supported-Versions: want 1, got %q", got)
	}
}

func TestResource_PostMethodReturns402AsWell(t *testing.T) {
	h := newHarness(t)
	rec := h.request(t, http.MethodPost, "")
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("POST without X-PAYMENT: want 402, got %d", rec.Code)
	}
}

func TestResource_HappyPathReturns200(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), []byte("unlocked")) {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
}

func TestResource_BadSignatureReturns400(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))
	// Flip the last byte of the signature.
	sigBytes, _ := base64.StdEncoding.DecodeString(rcpt.Signature)
	sigBytes[len(sigBytes)-1] ^= 0x01
	rcpt.Signature = base64.StdEncoding.EncodeToString(sigBytes)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "INVALID_RECEIPT")
}

func TestResource_ExpiredReceiptReturns400(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))

	// Move the clock past completedAt + MaxAge so the receipt is stale.
	h.clock.Advance(10 * time.Minute)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("stale: want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "INVALID_RECEIPT")
}

func TestResource_ReplayReturns409(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))
	payment := encodeReceipt(t, rcpt)

	if rec := h.request(t, http.MethodGet, payment); rec.Code != http.StatusOK {
		t.Fatalf("first call: want 200, got %d", rec.Code)
	}
	rec := h.request(t, http.MethodGet, payment)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: want 409, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "RECEIPT_REPLAYED")
}

// TestResource_ConcurrentSingleSuccess fires N concurrent verifies of the
// same valid receipt and asserts exactly one 200 and N-1 409s. Pins the
// PLAN.md §5.3 acceptance race ("100 goroutines"). Run with -race.
func TestResource_ConcurrentSingleSuccess(t *testing.T) {
	h := newHarness(t)
	// Bump the rate-limit high enough that 100 concurrent verifies do not
	// trip 429 — this test is about the replay-LRU race, not the limiter.
	h.rateLimit = 10_000
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))
	payment := encodeReceipt(t, rcpt)
	router := h.newRouter(h.rateLimit, int(h.rateLimit))

	const N = 100
	var success, replays, other int64
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, resourcePath, nil)
			req.RemoteAddr = "127.0.0.1:12345"
			req.Header.Set("X-PAYMENT", payment)
			router.ServeHTTP(rec, req)
			switch rec.Code {
			case http.StatusOK:
				atomic.AddInt64(&success, 1)
			case http.StatusConflict:
				atomic.AddInt64(&replays, 1)
			default:
				atomic.AddInt64(&other, 1)
			}
		}()
	}
	wg.Wait()

	if success != 1 || replays != N-1 || other != 0 {
		t.Fatalf("counts: success=%d replays=%d other=%d (want 1, %d, 0)", success, replays, other, N-1)
	}
}

func TestResource_WrongAmountReturns400Mismatch(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	r := baseReceipt(nonce)
	r.Amount = "9999.99"
	rcpt := sign(t, h.priv, r)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "RECEIPT_MISMATCH")
}

func TestResource_WrongMerchantReturns400Mismatch(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	r := baseReceipt(nonce)
	r.Merchant = "AttackerMerchant::1234"
	rcpt := sign(t, h.priv, r)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "RECEIPT_MISMATCH")
}

func TestResource_WrongResourceReturns400Mismatch(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	r := baseReceipt(nonce)
	r.Resource = "/other-resource"
	rcpt := sign(t, h.priv, r)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "RECEIPT_MISMATCH")
}

func TestResource_WrongTrustedIssuerReturns400Mismatch(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	r := baseReceipt(nonce)
	r.TrustedIssuer = "UntrustedIssuer::1234"
	rcpt := sign(t, h.priv, r)

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "RECEIPT_MISMATCH")
}

// TestResource_UnknownMerchantRequestId asserts that a receipt that
// otherwise verifies — fields match, signature valid — but carries a
// merchantRequestId the merchant never issued (or has been evicted) is
// rejected with 400 UNKNOWN_CHALLENGE. Resolves PLAN.md §6.7 round-3 P0:
// the prior "issued nonce exists" check did not bind the receipt to a
// specific 402 challenge.
func TestResource_UnknownMerchantRequestIdReturns400Unknown(t *testing.T) {
	h := newHarness(t)
	// Build a fully valid receipt with a nonce the merchant never issued.
	rcpt := sign(t, h.priv, baseReceipt("never-issued-nonce-22charsxxx"))
	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "UNKNOWN_CHALLENGE")
}

func TestResource_OversizeXPAYMENTReturns413(t *testing.T) {
	h := newHarness(t)
	// Build an X-PAYMENT value over the 8 KiB cap.
	oversize := strings.Repeat("a", h.resource.ReceiptMaxBytes+1)
	rec := h.request(t, http.MethodGet, oversize)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d", rec.Code)
	}
}

func TestResource_RateLimitReturns429(t *testing.T) {
	h := newHarness(t)
	// Force a tiny bucket so a small burst exhausts it deterministically.
	router := h.newRouter(1, 2)

	hit := func() int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, resourcePath, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// burst=2: first two should pass (402 — no header), the third hits 429.
	if c := hit(); c != http.StatusPaymentRequired {
		t.Fatalf("hit1: want 402, got %d", c)
	}
	if c := hit(); c != http.StatusPaymentRequired {
		t.Fatalf("hit2: want 402, got %d", c)
	}
	if c := hit(); c != http.StatusTooManyRequests {
		t.Fatalf("hit3: want 429, got %d", c)
	}
}

func TestResource_InvalidBase64Returns400(t *testing.T) {
	h := newHarness(t)
	rec := h.request(t, http.MethodGet, "!!!not base64!!!")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "INVALID_INPUT")
}

// TestResource_TamperedHashReturns400 — the receipt's display digest
// (receiptPayloadHash) is recomputed by verify; a flip there with the
// signature still matching the canonical bytes surfaces as 400
// INVALID_RECEIPT (the canonical signature still validates, but the
// payloadHash diff is the defence-in-depth integrity check).
func TestResource_TamperedReceiptPayloadHashReturns400(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))

	// Replace the digest with a different (well-formed base64) hash.
	junk := sha256.Sum256([]byte("not-the-canonical-bytes"))
	rcpt.ReceiptPayloadHash = base64.StdEncoding.EncodeToString(junk[:])

	rec := h.request(t, http.MethodGet, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	assertErrorCode(t, rec, "INVALID_RECEIPT")
}

func TestResource_PostMethodHappyPath(t *testing.T) {
	h := newHarness(t)
	nonce := h.requestWith402(t)
	rcpt := sign(t, h.priv, baseReceipt(nonce))
	rec := h.request(t, http.MethodPost, encodeReceipt(t, rcpt))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST happy-path: want 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// assertErrorCode parses the canonical merchant error envelope and asserts
// the "code" field. Keeps the per-test boilerplate minimal.
func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	body, err := io.ReadAll(rec.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode error envelope: %v (body=%q)", err, string(body))
	}
	if env.Error.Code != want {
		t.Fatalf("error.code: want %q, got %q (body=%q)", want, env.Error.Code, string(body))
	}
}
