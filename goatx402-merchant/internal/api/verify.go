// Package api implements the merchant's HTTP surface: a single
// GET-and-POST /resource handler plus a verify wrapper that composes
// pkg/receipt/verify with the merchant's tuple-match and replay caches.
package api

import (
	"crypto/ed25519"
	"errors"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/replay"
	"github.com/goatnetwork/goatx402-receipt"
	"github.com/goatnetwork/goatx402-receipt/verify"
)

// VerifyError is the merchant-side classification of a verify failure.
// Each value maps 1:1 to an HTTP status the resource handler returns
// (PLAN.md §5.3 + §6.7).
type VerifyError int

const (
	// VerifyOK indicates the receipt verified, the field tuple matched,
	// and the receipt-replay slot was successfully consumed. Serve 200.
	VerifyOK VerifyError = iota
	// VerifyInvalid covers signature, schema, freshness, and skew failures
	// surfaced by pkg/receipt/verify. Mapped to 400 INVALID_RECEIPT.
	VerifyInvalid
	// VerifyMismatch means signature was good but a tuple field
	// (amount/currency/trustedIssuer/merchant/resource) disagrees with the
	// merchant's expectations. Mapped to 400 RECEIPT_MISMATCH.
	VerifyMismatch
	// VerifyUnknownChallenge means receipt.merchantRequestId was never
	// issued by this merchant (or has been evicted from the issuance
	// LRU). Mapped to 400 UNKNOWN_CHALLENGE.
	VerifyUnknownChallenge
	// VerifyReplayed means the (ledgerId, transactionId) tuple has already
	// been consumed. Mapped to 409 RECEIPT_REPLAYED.
	VerifyReplayed
)

// VerifyResult bundles a coarse classification with the underlying error
// from pkg/receipt/verify so callers can structured-log it. The handler
// emits a stable HTTP code without leaking the verifier's specific
// failure.
type VerifyResult struct {
	Outcome  VerifyError
	Detail   string
	UnderErr error
}

// Verifier wires a pinned participant pubkey + clock skew tolerance with
// the merchant's issuance and replay caches.
//
// MaxAge / MaxClockSkew / AcceptKeys are baked into the Verifier so the
// no-I/O contract of pkg/receipt/verify is preserved (the verifier reads
// no env). Now() is sampled on each Verify call so freshness checks
// reflect wall time, not boot time.
type Verifier struct {
	MaxAge        time.Duration
	MaxClockSkew  time.Duration
	AcceptKeys    []ed25519.PublicKey
	ParticipantPK ed25519.PublicKey
	Expected      replay.ChallengeTuple
	Issuance      *replay.IssuedNonces
	ReplayCache   *replay.ReceiptReplay
	Now           func() time.Time
}

// Verify runs the full pipeline:
//
//  1. pkg/receipt/verify.Verify (offline signature, freshness, skew)
//  2. tuple match against Verifier.Expected
//  3. atomic Match against the issuance LRU (lookup + tuple compare under
//     the same mutex)
//  4. atomic Consume of the replay LRU
//
// The order is deliberately:
//   - signature/freshness FIRST so attackers cannot probe the issuance or
//     replay caches without a valid signature;
//   - replay-LRU LAST so concurrent verifies of the same VALID receipt
//     all reach step 4 and exactly one wins (PLAN.md §5.3 race test).
func (v *Verifier) Verify(r receipt.CantonReceipt) VerifyResult {
	now := time.Now
	if v.Now != nil {
		now = v.Now
	}
	opts := verify.VerifyOptions{
		Now:          now(),
		MaxAge:       v.MaxAge,
		MaxClockSkew: v.MaxClockSkew,
		AcceptKeys:   v.AcceptKeys,
	}
	if err := verify.Verify(r, v.ParticipantPK, opts); err != nil {
		return VerifyResult{Outcome: VerifyInvalid, Detail: detailFor(err), UnderErr: err}
	}

	if r.Amount != v.Expected.Amount {
		return VerifyResult{Outcome: VerifyMismatch, Detail: "amount"}
	}
	if r.Currency != v.Expected.Currency {
		return VerifyResult{Outcome: VerifyMismatch, Detail: "currency"}
	}
	if r.TrustedIssuer != v.Expected.TrustedIssuer {
		return VerifyResult{Outcome: VerifyMismatch, Detail: "trustedIssuer"}
	}
	if r.Merchant != v.Expected.Merchant {
		return VerifyResult{Outcome: VerifyMismatch, Detail: "merchant"}
	}
	if r.Resource != v.Expected.Resource {
		return VerifyResult{Outcome: VerifyMismatch, Detail: "resource"}
	}

	// Issuance lookup binds the receipt to the specific 402 challenge that
	// minted its merchantRequestId — closes the "nonce issued for cheap
	// resource A reused with order for expensive resource B" surface from
	// PLAN.md §6.7.
	switch v.Issuance.Match(r.MerchantRequestID, replay.ChallengeTuple{
		Merchant:      r.Merchant,
		Resource:      r.Resource,
		Amount:        r.Amount,
		Currency:      r.Currency,
		TrustedIssuer: r.TrustedIssuer,
	}) {
	case replay.MatchUnknown:
		return VerifyResult{Outcome: VerifyUnknownChallenge}
	case replay.MatchTupleMismatch:
		return VerifyResult{Outcome: VerifyMismatch, Detail: "issuance"}
	case replay.MatchOK:
		// fall through
	}

	key := r.LedgerID + "|" + r.TransactionID
	if err := v.ReplayCache.Consume(key); err != nil {
		if errors.Is(err, replay.ErrAlreadyConsumed) {
			return VerifyResult{Outcome: VerifyReplayed}
		}
		return VerifyResult{Outcome: VerifyInvalid, Detail: "replay", UnderErr: err}
	}

	return VerifyResult{Outcome: VerifyOK}
}

// detailFor surfaces a coarse, non-leaky tag for the structured logger so
// operators can grep failure rates by kind. The full error stays in
// UnderErr for the local log line; the wire never carries verifier
// internals.
func detailFor(err error) string {
	switch {
	case errors.Is(err, verify.ErrUnsupportedScheme):
		return "scheme"
	case errors.Is(err, verify.ErrBadSignature):
		return "signature"
	case errors.Is(err, verify.ErrPayloadMismatch):
		return "payloadHash"
	case errors.Is(err, verify.ErrStale):
		return "stale"
	case errors.Is(err, verify.ErrFutureDated):
		return "futureDated"
	case errors.Is(err, verify.ErrTooManyAcceptKeys):
		return "acceptKeys"
	default:
		return "invalid"
	}
}
