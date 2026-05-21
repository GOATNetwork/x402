// Package sign owns the participant-operator Ed25519 key that produces the
// signed CantonReceipt artefact merchants verify (PLAN.md §6.4 + Task 9).
//
// The flow is:
//
//	1. The completion-stream handler observes mediator-confirm for a commandId.
//	2. It builds a draft CantonReceipt from the order + TransactionDetails.
//	3. It calls Signer.Sign which:
//	     a. Canonicalises the receipt via pkg/receipt.Canonical().
//	     b. Computes receiptPayloadHash = base64(sha256(canonical)).
//	     c. Signs the canonical bytes with PureEdDSA (NOT the hash).
//	     d. Re-verifies via pkg/receipt/verify.Verify against the configured
//	        public key. A self-verify failure short-circuits with
//	        ErrSelfVerifyFailed — the receipt is NEVER persisted (PLAN.md §6.2
//	        self-verify invariant; resolves the round-3 P0 on the wait=false
//	        path that previously swallowed structural-integrity errors).
//
// Logs never emit signature bytes, key material, or `payment_request_contract_id`
// per the §9.2 redaction list.
package sign

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/goatnetwork/goatx402-receipt"
	"github.com/goatnetwork/goatx402-receipt/verify"
)

// ErrEmptyKey is returned when NewSigner is called with no private key.
var ErrEmptyKey = errors.New("sign: empty participant-operator key")

// ErrSelfVerifyFailed is the sentinel that callers must NEVER swallow. A
// signed receipt that does not round-trip through pkg/receipt/verify is a
// structural-integrity bug (canonicalisation drift, public/private key
// mismatch). Persisting it would corrupt the merchant trust anchor.
var ErrSelfVerifyFailed = errors.New("sign: self-verify failed")

// VerifyOptionsBuilder produces a verify.VerifyOptions value at Sign time. The
// indirection exists so callers inject a deterministic clock and tolerance
// without the sign package reaching for time.Now / env vars directly.
type VerifyOptionsBuilder func() verify.VerifyOptions

// Signer produces a fully-signed, self-verified CantonReceipt.
type Signer struct {
	priv             ed25519.PrivateKey
	pub              ed25519.PublicKey
	domain           string
	scheme           string
	verifyOptsBuild  VerifyOptionsBuilder
}

// SignerOptions configures the Signer at construction time.
type SignerOptions struct {
	// PrivateKey is the participant-operator Ed25519 private key. Required.
	// In v0 dev: from PARTICIPANT_SIGNING_KEY_PATH. In CANTON_PROD: from an
	// HSM bridge — callers should never read a plain file in prod (the
	// config matrix enforces that).
	PrivateKey ed25519.PrivateKey

	// PublicKey is the matching public half. Required so the self-verify
	// round trip uses the same key the merchant will pin via
	// PARTICIPANT_PUBKEY_PATH.
	PublicKey ed25519.PublicKey

	// Domain is the receipt domain separation tag (default receipt.DomainV1).
	Domain string

	// SignatureScheme is the wire-side scheme name (default Ed25519).
	SignatureScheme string

	// VerifyOptions builds the verify.VerifyOptions used by the self-verify
	// round trip. Default: Now = time.Now().UTC(), MaxAge = 5m,
	// MaxClockSkew = 30s. Tests can inject a deterministic clock.
	VerifyOptions VerifyOptionsBuilder
}

// NewSigner constructs a Signer. The private key is held in memory; logs
// emit only the public key fingerprint, never the bytes themselves.
func NewSigner(opts SignerOptions) (*Signer, error) {
	if len(opts.PrivateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%w (have %d, want %d)", ErrEmptyKey, len(opts.PrivateKey), ed25519.PrivateKeySize)
	}
	if len(opts.PublicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("sign: public key wrong size (have %d, want %d)", len(opts.PublicKey), ed25519.PublicKeySize)
	}
	// Defence-in-depth: cross-check the public/private halves derive the
	// same key. ed25519.PrivateKey.Public() panics on malformed input but
	// returns a stable result for well-formed keys. We compare bytes so a
	// pubkey from a different keypair fails at construction (not at the
	// first /proof call).
	derived, ok := opts.PrivateKey.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("sign: private key Public() did not return ed25519.PublicKey")
	}
	if !equalBytes(derived, opts.PublicKey) {
		return nil, fmt.Errorf("sign: PublicKey does not match PrivateKey")
	}

	domain := opts.Domain
	if domain == "" {
		domain = receipt.DomainV1
	}
	scheme := opts.SignatureScheme
	if scheme == "" {
		scheme = receipt.SignatureSchemeEd25519
	}
	builder := opts.VerifyOptions
	if builder == nil {
		builder = func() verify.VerifyOptions {
			return verify.VerifyOptions{
				Now:          time.Now().UTC(),
				MaxAge:       5 * time.Minute,
				MaxClockSkew: 30 * time.Second,
			}
		}
	}
	return &Signer{
		priv:            opts.PrivateKey,
		pub:             opts.PublicKey,
		domain:          domain,
		scheme:          scheme,
		verifyOptsBuild: builder,
	}, nil
}

// PublicKey returns the public half. Used by /readyz wiring and tests; the
// merchant pins its own copy via PARTICIPANT_PUBKEY_PATH and does NOT trust
// the facilitator's runtime value.
func (s *Signer) PublicKey() ed25519.PublicKey {
	return s.pub
}

// Sign accepts a draft receipt (every field populated EXCEPT Signature,
// ReceiptPayloadHash, Version, Domain, and SignatureScheme — the signer fills
// those four) and returns the fully-signed receipt, ready for
// store.SaveReceiptAndConfirm.
//
// Self-verify discipline (PLAN.md §6.2 + §6.6): after signing, the function
// runs the merchant's verifier path against the freshly-signed receipt. A
// failure here means our canonical bytes do not round-trip through the
// verifier we ship — that is a structural-integrity bug; we return
// ErrSelfVerifyFailed and the caller must NOT persist the receipt.
func (s *Signer) Sign(draft receipt.CantonReceipt) (receipt.CantonReceipt, error) {
	if s == nil {
		return receipt.CantonReceipt{}, fmt.Errorf("sign: nil signer")
	}
	out := draft
	if out.Version == "" {
		out.Version = receipt.SchemaVersion
	}
	if out.Domain == "" {
		out.Domain = s.domain
	}
	if out.SignatureScheme == "" {
		out.SignatureScheme = s.scheme
	}
	// Clear any caller-supplied Signature / ReceiptPayloadHash before
	// canonicalising — Canonical() does not include them, but explicit is
	// safer than implicit.
	out.Signature = ""
	out.ReceiptPayloadHash = ""

	canonical, err := out.Canonical()
	if err != nil {
		return receipt.CantonReceipt{}, fmt.Errorf("sign: canonicalise: %w", err)
	}

	sig := ed25519.Sign(s.priv, canonical)
	out.Signature = base64.StdEncoding.EncodeToString(sig)
	digest := sha256.Sum256(canonical)
	out.ReceiptPayloadHash = base64.StdEncoding.EncodeToString(digest[:])

	// Self-verify before persist.
	if err := verify.Verify(out, s.pub, s.verifyOptsBuild()); err != nil {
		return receipt.CantonReceipt{}, fmt.Errorf("%w: %v", ErrSelfVerifyFailed, err)
	}
	return out, nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Fingerprint returns the first 8 hex characters of sha256(pub). Suitable for
// structured logs; never includes key material.
func Fingerprint(pub ed25519.PublicKey) string {
	if len(pub) == 0 {
		return ""
	}
	h := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(h[:6])
}
