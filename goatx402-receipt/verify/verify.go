// Package verify implements the offline CantonReceipt signature verifier.
//
// The package is deliberately I/O-free: it imports neither net, os, nor any
// configuration source. All inputs are passed explicitly via VerifyOptions so
// merchants, clients, and tests share one deterministic verification path.
// A sibling no_network_test.go enforces the no-net invariant at build time by
// invoking `go list -deps` over this package's import closure.
package verify

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/goatnetwork/goatx402-receipt"
)

// MaxAcceptKeys bounds the rotation window's acceptable-keys slice. §6.4 fixes
// this at 1 so a misconfigured stale key cannot silently revert a completed
// rotation (resolves cross-review P1 on stale-key rollback).
const MaxAcceptKeys = 1

// Verification errors. Kept as sentinel values so callers and tests can use
// errors.Is for table-driven assertions.
var (
	// ErrUnsupportedScheme is returned when the receipt advertises a
	// signatureScheme this verifier does not accept (only "Ed25519" in v0).
	ErrUnsupportedScheme = errors.New("verify: unsupported signature scheme")

	// ErrBadSignature is returned when the participant-operator signature fails
	// to validate under the primary key and (if configured) any rotation
	// AcceptKey.
	ErrBadSignature = errors.New("verify: bad signature")

	// ErrPayloadMismatch is returned when the display-only receiptPayloadHash
	// does not match sha256(canonical). The signature is over the canonical
	// bytes, so this is a defence-in-depth integrity diff against canonical
	// drift between signer and verifier.
	ErrPayloadMismatch = errors.New("verify: receipt payload hash mismatch")

	// ErrStale is returned when opts.Now is past completedAt + MaxAge.
	ErrStale = errors.New("verify: stale receipt")

	// ErrFutureDated is returned when completedAt is past opts.Now +
	// MaxClockSkew. Resolves cross-review P1: the prior wording referenced an
	// undefined `skew` field and is now bound to opts.MaxClockSkew.
	ErrFutureDated = errors.New("verify: future-dated receipt")

	// ErrTooManyAcceptKeys is returned when VerifyOptions.AcceptKeys carries
	// more than MaxAcceptKeys entries. The rotation contract in §6.4 caps the
	// window at exactly one trailing key.
	ErrTooManyAcceptKeys = errors.New("verify: AcceptKeys must contain at most one key")
)

// VerifyOptions carries every input the verifier reads. All fields are
// explicit so the package performs zero env reads, zero file I/O, and zero
// network calls. Merchants pass their own clock and tolerances; tests pass
// fixtures.
type VerifyOptions struct {
	// Now is the wall-clock used for both staleness and future-dated checks.
	// Must be non-zero or both time checks will be vacuously true.
	Now time.Time

	// MaxAge is the freshness window after completedAt.
	// A receipt is stale once Now > completedAt + MaxAge.
	MaxAge time.Duration

	// MaxClockSkew tolerates participant clocks running ahead of opts.Now.
	// A receipt is future-dated once completedAt > Now + MaxClockSkew.
	MaxClockSkew time.Duration

	// AcceptKeys is an OPTIONAL trailing-key slice for the double-deploy
	// rotation window described in §6.4. If a signature does not validate
	// under the primary participantPubKey, the verifier retries against any
	// key in AcceptKeys. Bounded at MaxAcceptKeys; longer slices are rejected
	// up-front with ErrTooManyAcceptKeys (resolves cross-review P1).
	AcceptKeys []ed25519.PublicKey
}

// Verify validates a CantonReceipt against a participant-operator public key
// under the merchant-supplied options. It returns nil on success or one of the
// sentinel errors above on failure.
//
// Check order (chosen so the most informative error wins):
//  1. AcceptKeys arity (cheap structural)
//  2. SignatureScheme (cheap structural)
//  3. Canonical preimage available (catches a missing Domain etc.)
//  4. Ed25519 signature over canonical bytes
//  5. ReceiptPayloadHash matches sha256(canonical)
//  6. Time bounds (stale before future-dated so a wildly stale clock is named)
//
// PureEdDSA (Go stdlib `ed25519.Sign`) signs the canonical bytes directly. The
// display digest `receiptPayloadHash` is verified separately as a structural
// integrity check; it is NOT the input to ed25519.Verify.
func Verify(r receipt.CantonReceipt, participantPubKey ed25519.PublicKey, opts VerifyOptions) error {
	if len(opts.AcceptKeys) > MaxAcceptKeys {
		return ErrTooManyAcceptKeys
	}

	if r.SignatureScheme != receipt.SignatureSchemeEd25519 {
		return ErrUnsupportedScheme
	}

	canonical, err := r.Canonical()
	if err != nil {
		return fmt.Errorf("verify: canonicalise receipt: %w", err)
	}

	sig, err := base64.StdEncoding.DecodeString(r.Signature)
	if err != nil {
		return ErrBadSignature
	}

	if !verifyAgainstAny(canonical, sig, participantPubKey, opts.AcceptKeys) {
		return ErrBadSignature
	}

	digest := sha256.Sum256(canonical)
	if base64.StdEncoding.EncodeToString(digest[:]) != r.ReceiptPayloadHash {
		return ErrPayloadMismatch
	}

	completedAt := time.UnixMilli(r.CompletedAt)
	if opts.Now.After(completedAt.Add(opts.MaxAge)) {
		return ErrStale
	}
	if completedAt.After(opts.Now.Add(opts.MaxClockSkew)) {
		return ErrFutureDated
	}

	return nil
}

// verifyAgainstAny tries the primary key first, then each AcceptKey. ed25519
// .Verify is constant-time per call and returns false on a length mismatch, so
// passing an over-short pubkey is safe (it just fails verification).
func verifyAgainstAny(message, sig []byte, primary ed25519.PublicKey, accept []ed25519.PublicKey) bool {
	if len(primary) == ed25519.PublicKeySize && ed25519.Verify(primary, message, sig) {
		return true
	}
	for _, k := range accept {
		if len(k) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(k, message, sig) {
			return true
		}
	}
	return false
}
