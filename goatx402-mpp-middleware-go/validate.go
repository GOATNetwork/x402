package mppmiddleware

import (
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	receiptspec "github.com/goatnetwork/goatx402-mpp-middleware-go/receiptspec"
)

// verifyResult is the unified return type of verify. Exactly one of
// the following is true after a call:
//
//   - Status == 0 and Reason == "": verification succeeded; Receipt
//     holds the decoded value.
//   - Status != 0 and Reason != "": verification failed; Receipt is
//     zero-valued and should not be inspected.
//
// Status is one of http.StatusUnauthorized (401) or
// http.StatusPaymentRequired (402). The split follows the MPP
// semantics: 401 = "you presented bad credentials, fix and retry";
// 402 = "you need a (different / new) payment receipt".
type verifyResult struct {
	Receipt receiptspec.Receipt
	Reason  string
	Status  int
}

// verify performs the full pipeline of checks documented in the
// package overview. It is extracted from Middleware so it can be
// exercised in unit tests without spinning up an http.Handler.
//
// The check order is deliberate:
//
//  1. Header presence — cheapest possible reject.
//  2. Header structural parse + algorithm match — fails fast on
//     malformed input.
//  3. Receipt structural validation — catches obvious shape issues
//     before doing expensive crypto.
//  4. Signature verification — cryptographic check.
//  5. Audience binding (merchant_id) — semantic check that requires
//     no further state.
//  6. Route binding (request_canonical vs RouteCanonical).
//  7. Expiry — done last because it is the most likely
//     legitimate-traffic reject and is cheap.
//
// Steps 1-4 reject with 401 (credentials issue). Steps 6-7 reject with
// 402 (the buyer needs a different receipt for this resource or a
// fresh receipt). Step 5 is 401 because an audience mismatch is a
// stronger "this credential cannot be used here" signal than a missing
// route binding.
func verify(cfg Config, header string, now time.Time) verifyResult {
	if header == "" {
		return verifyResult{Reason: ReasonPaymentRequired, Status: http.StatusUnauthorized}
	}

	receipt, sig, alg, err := receiptspec.DecodeHeader(header)
	if err != nil {
		return verifyResult{Reason: ReasonInvalidPaymentReceipt, Status: http.StatusUnauthorized}
	}

	// Algorithm confusion guard: reject if the on-wire algorithm does
	// not match what the middleware was configured to accept. We do
	// NOT silently fall back to "try both" — that would be a
	// downgrade-attack surface.
	if alg != cfg.Algorithm {
		return verifyResult{Reason: ReasonInvalidSignature, Status: http.StatusUnauthorized}
	}

	if err := receipt.Validate(); err != nil {
		return verifyResult{Reason: ReasonInvalidPaymentReceipt, Status: http.StatusUnauthorized}
	}

	switch alg {
	case receiptspec.AlgEd25519:
		// Length check is defense-in-depth — ed25519.Verify also
		// returns false on wrong-length input.
		if len(sig) != 64 || !receiptspec.VerifyEd25519(cfg.Ed25519Public, receipt, sig) {
			return verifyResult{Reason: ReasonInvalidSignature, Status: http.StatusUnauthorized}
		}
	case receiptspec.AlgHMACSHA256:
		if len(sig) != 32 || !receiptspec.VerifyHMAC(cfg.HMACSecret, receipt, sig) {
			return verifyResult{Reason: ReasonInvalidSignature, Status: http.StatusUnauthorized}
		}
	default:
		// Unreachable given the IsValid check inside DecodeHeader plus
		// the cfg.Algorithm == alg check above, but treat any future
		// algorithm we have not been taught about as an invalid sig
		// rather than silently passing.
		return verifyResult{Reason: ReasonInvalidSignature, Status: http.StatusUnauthorized}
	}

	// Audience binding. Use constant-time string compare to avoid
	// timing oracles that could leak the configured MerchantID
	// character by character. MerchantID is not secret per se but
	// constant-time compare on equal-length inputs is essentially
	// free and matches the receipt-spec convention.
	if !constantTimeEqualStr(receipt.MerchantID, cfg.MerchantID) {
		return verifyResult{Reason: ReasonAudienceMismatch, Status: http.StatusUnauthorized}
	}

	// Route binding. Either the receipt's request_canonical equals
	// the configured RouteCanonical exactly, or it begins with
	// "<RouteCanonical>:" — the trailing colon is required to
	// prevent prefix-confusion (e.g., a receipt for "GET:/api/data"
	// must not satisfy a route of "GET:/api").
	rc := receipt.RequestCanonical
	if rc != cfg.RouteCanonical && !strings.HasPrefix(rc, cfg.RouteCanonical+":") {
		return verifyResult{Reason: ReasonRouteMismatch, Status: http.StatusPaymentRequired}
	}

	// Expiry. The receipt-spec Validate already ensured expires_at >
	// issued_at; here we enforce the wall-clock side: now must be
	// strictly before expires_at. Equality counts as expired (the
	// receipt was valid for [issued_at, expires_at) by convention).
	if !now.Before(receipt.ReceiptExpiresAt) {
		return verifyResult{Reason: ReasonReceiptExpired, Status: http.StatusPaymentRequired}
	}

	return verifyResult{Receipt: receipt}
}

// constantTimeEqualStr is a constant-time equality check over two
// strings. We do not import the receipt-spec internal helper because
// that helper is unexported; mirroring it here keeps the module
// boundary clean.
func constantTimeEqualStr(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
