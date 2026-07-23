package mppmiddleware_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"time"

	mppmiddleware "github.com/goatnetwork/goatflow-mpp-middleware-go"
	receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

// Example demonstrates the canonical wiring for a Go merchant resource
// server: build a Config bound to one merchant_id + one route, wrap
// the protected handler, and read the verified Receipt out of the
// request context inside the handler. The example uses a stub buyer
// flow (the platform signs a receipt) so it can run as a self-contained
// Example test.
func Example() {
	// In production, Ed25519Public is the published platform key; the
	// private key lives in x402d's signer module.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}

	const merchantID = "merch_demo"
	const route = "GET:/api/data"

	// Wire the middleware.
	mw := mppmiddleware.Middleware(mppmiddleware.Config{
		MerchantID:     merchantID,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
	})

	// Protected handler reads the verified receipt out of context.
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rcpt, ok := mppmiddleware.FromContext(r.Context())
		if !ok {
			http.Error(w, "no receipt", http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, "paid for tx=%s amount=%s", rcpt.TxHash, rcpt.AmountWei)
	}))

	// --- Stub the buyer side so the example runs end-to-end. ---
	issued := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	rcpt := receiptspec.Receipt{
		ReceiptID:        receiptspec.DeriveReceiptID("chal", "ord", "0xabc", 1),
		ChallengeID:      "chal",
		OrderID:          "ord",
		MerchantID:       merchantID,
		PayerAddr:        "0x1111111111111111111111111111111111111111",
		ChainID:          1,
		TokenContract:    "0x2222222222222222222222222222222222222222",
		Recipient:        "0x3333333333333333333333333333333333333333",
		AmountWei:        "1000000",
		RequestCanonical: route,
		TxHash:           "0xabc",
		LogIndex:         1,
		BlockNumber:      100,
		BlockTimestamp:   issued,
		ReceiptIssuedAt:  issued,
		ReceiptExpiresAt: issued.Add(time.Hour),
	}
	sig := receiptspec.SignEd25519(priv, rcpt)
	hdr, err := receiptspec.EncodeHeader(rcpt, sig, receiptspec.AlgEd25519)
	if err != nil {
		panic(err)
	}

	// Send the request. We use a fresh middleware with a fixed Clock
	// here so the example output is deterministic regardless of when
	// the test runs (the issued/expiry timestamps are far past). In a
	// real server you would simply use the production middleware
	// above with the default clock.
	mwFixed := mppmiddleware.Middleware(mppmiddleware.Config{
		MerchantID:     merchantID,
		RouteCanonical: route,
		Algorithm:      receiptspec.AlgEd25519,
		Ed25519Public:  pub,
		Clock:          func() time.Time { return issued.Add(time.Minute) },
	})
	handlerFixed := mwFixed(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rcpt, _ := mppmiddleware.FromContext(r.Context())
		fmt.Fprintf(w, "paid for tx=%s amount=%s", rcpt.TxHash, rcpt.AmountWei)
	}))
	_ = handler // silence unused for the production-style binding above

	req := httptest.NewRequest("GET", "/api/data", nil)
	req.Header.Set(mppmiddleware.HeaderName, hdr)
	w := httptest.NewRecorder()
	handlerFixed.ServeHTTP(w, req)
	fmt.Println(w.Code, w.Body.String())

	// Output: 200 paid for tx=0xabc amount=1000000
}
