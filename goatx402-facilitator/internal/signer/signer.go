// Package signer abstracts over who holds the payer's signing key. The seam
// exists from day one so F10 can swap CustodialSigner for BYOSigner without
// touching the HTTP handlers (PLAN.md §6.3).
//
// The Signer parameter is the *canonical message bytes* (typically the output
// of pkg/receipt.CanonicalSubmission) and is fed directly into PureEdDSA. The
// signer must never receive a pre-computed digest — the prior payload-hash-as-
// input wording was superseded by the round-3 signature-target contradiction
// fix (PLAN.md §6.3 and §5.1 /calldata-signature).
package signer

import (
	"context"
	"crypto/ed25519"
	"errors"
)

// SchemeEd25519 is the only signature scheme accepted in v0.
const SchemeEd25519 = "Ed25519"

// Signature is the opaque signing output. Wire-side it is base64-encoded; in
// memory we expose the raw bytes plus the scheme name so callers can build the
// HTTP response or attach it to the canonical receipt.
type Signature struct {
	Scheme string
	Bytes  []byte
}

// Signer abstracts over who holds the payer signing key. Implementations MUST
// treat message as the canonical bytes to sign (PureEdDSA) and MUST NOT log or
// otherwise expose the underlying key material.
type Signer interface {
	// Sign produces an Ed25519 signature over message using the key bound to
	// party. Errors must not leak key material.
	Sign(ctx context.Context, party string, message []byte) (Signature, error)
	// PublicKey returns the public half of the key bound to party.
	PublicKey(party string) (ed25519.PublicKey, error)
}

// Errors returned by Signer implementations. None of these wrap key material;
// the offending partyId is the only identifier safe to surface.
var (
	// ErrPartyNotFound indicates the party has no key registered with this
	// signer.
	ErrPartyNotFound = errors.New("signer: party not registered")
	// ErrEmptyMessage indicates Sign was called with a zero-length canonical
	// message. PureEdDSA permits empty input, but the protocol does not.
	ErrEmptyMessage = errors.New("signer: empty message")
	// ErrInvalidKey indicates a key file or registry entry could not be parsed
	// as a valid Ed25519 key (wrong length, malformed encoding, etc.).
	ErrInvalidKey = errors.New("signer: invalid ed25519 key material")
	// ErrBYONotWired is returned by BYOSigner in v0; F10 swaps in the concrete
	// implementation.
	ErrBYONotWired = errors.New("signer: BYO signer not wired (F10)")
	// ErrRegistryMismatch is the sentinel for the boot-time key-pair
	// self-check failure. Boot wiring (Task 9) translates this into the
	// KEY_BINDING_MISMATCH structured error documented in PLAN.md §6.3.
	ErrRegistryMismatch = errors.New("signer: KEY_BINDING_MISMATCH")
)
