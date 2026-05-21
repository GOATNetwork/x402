package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/replay"
	"github.com/goatnetwork/goatx402-receipt"
)

// Resource wires the per-merchant state needed to serve GET/POST
// /resource. A single Resource instance handles both verbs — PLAN.md §1.3
// vs §5.3 reconciliation: both verbs share the same handler.
type Resource struct {
	// MerchantPartyID is mirrored into the 402 envelope and asserted on
	// the returned receipt.
	MerchantPartyID string

	// ResourcePath is the path the merchant gates and that the receipt
	// must echo.
	ResourcePath string

	// Amount, Currency, TrustedIssuer are the rest of the challenge tuple
	// advertised in 402 and asserted on the receipt.
	Amount        string
	Currency      string
	TrustedIssuer string

	// FacilitatorURL is advertised so the client knows where to mint the
	// payment order.
	FacilitatorURL string

	// ReceiptMaxBytes caps the X-PAYMENT header value length before
	// base64-decode (PLAN.md §5.5). Oversize → 413.
	ReceiptMaxBytes int

	// Verifier composes pkg/receipt/verify with the merchant's
	// tuple-match + replay caches.
	Verifier *Verifier

	// Issuance is the issued-nonce LRU populated at 402 issuance time
	// (PLAN.md §5.3).
	Issuance *replay.IssuedNonces

	// Body is the protected content returned on 200.
	Body []byte

	// Logger is used for structured log lines; replace with a per-request
	// logger if higher fidelity is needed.
	Logger *slog.Logger

	// Now is the clock; injectable for tests.
	Now func() time.Time

	// RandReader supplies the merchantRequestId entropy; injectable for
	// tests so the 402 envelope is reproducible.
	RandReader func(b []byte) (int, error)
}

// ServeHTTP implements http.Handler. The same code path serves both GET
// and POST per PLAN.md §1.3 / §5.3.
func (rs *Resource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := r.Header.Get("X-PAYMENT")
	if header == "" {
		rs.write402(w)
		return
	}
	if len(header) > rs.ReceiptMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
			fmt.Sprintf("X-PAYMENT header exceeds %d bytes", rs.ReceiptMaxBytes))
		return
	}

	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "X-PAYMENT is not valid base64")
		return
	}

	var rcpt receipt.CantonReceipt
	if err := json.Unmarshal(raw, &rcpt); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "X-PAYMENT is not valid CantonReceipt JSON")
		return
	}

	res := rs.Verifier.Verify(rcpt)
	switch res.Outcome {
	case VerifyOK:
		rs.writeContent(w)
		rs.log("info", "resource unlocked",
			"order_id", rcpt.OrderID,
			"tx_id", rcpt.TransactionID,
		)
	case VerifyInvalid:
		writeError(w, http.StatusBadRequest, "INVALID_RECEIPT", "receipt verification failed")
		rs.log("warn", "receipt verify failed",
			"reason", res.Detail,
			"err", safeErr(res.UnderErr),
		)
	case VerifyMismatch:
		writeError(w, http.StatusBadRequest, "RECEIPT_MISMATCH", "receipt does not match challenge")
		rs.log("warn", "receipt mismatch", "field", res.Detail)
	case VerifyUnknownChallenge:
		writeError(w, http.StatusBadRequest, "UNKNOWN_CHALLENGE", "merchantRequestId unknown or expired")
		rs.log("warn", "unknown challenge", "order_id", rcpt.OrderID)
	case VerifyReplayed:
		writeError(w, http.StatusConflict, "RECEIPT_REPLAYED", "receipt has already been redeemed")
		rs.log("warn", "receipt replayed", "order_id", rcpt.OrderID)
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "unexpected verify outcome")
	}
}

func (rs *Resource) write402(w http.ResponseWriter) {
	nonce, err := rs.mintNonce()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "NONCE_MINT_FAILED", "could not mint challenge")
		return
	}
	rs.Issuance.Issue(nonce, replay.ChallengeTuple{
		Merchant:      rs.MerchantPartyID,
		Resource:      rs.ResourcePath,
		Amount:        rs.Amount,
		Currency:      rs.Currency,
		TrustedIssuer: rs.TrustedIssuer,
	})

	envelope := map[string]any{
		"x402Version": 1,
		"accepts": []map[string]any{{
			"scheme":            "canton-daml",
			"amount":            rs.Amount,
			"currency":          rs.Currency,
			"trustedIssuer":     rs.TrustedIssuer,
			"payTo":             rs.MerchantPartyID,
			"facilitator":       rs.FacilitatorURL,
			"resource":          rs.ResourcePath,
			"merchantRequestId": nonce,
		}},
		"error": "payment_required",
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-X402-Supported-Versions", "1")
	w.WriteHeader(http.StatusPaymentRequired)
	_ = json.NewEncoder(w).Encode(envelope)
}

func (rs *Resource) writeContent(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rs.Body)
}

// mintNonce produces a base64url 22-char (16-byte) random nonce that
// matches the §5.3 charset/length constraint.
func (rs *Resource) mintNonce() (string, error) {
	buf := make([]byte, 16)
	reader := rs.RandReader
	if reader == nil {
		reader = rand.Read
	}
	if _, err := reader(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (rs *Resource) log(level, msg string, attrs ...any) {
	if rs.Logger == nil {
		return
	}
	switch level {
	case "warn":
		rs.Logger.Warn(msg, attrs...)
	case "error":
		rs.Logger.Error(msg, attrs...)
	default:
		rs.Logger.Info(msg, attrs...)
	}
}

// writeError emits the canonical merchant error shape: {"error":{"code":...,"message":...}}.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func safeErr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
