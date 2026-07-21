package signer

import (
	"context"
	"crypto/ed25519"
)

// BYOSigner is the F10 placeholder. Day-zero presence keeps the Signer seam
// real so handlers compile against the same interface they will hold in F10.
// All methods return ErrBYONotWired; concrete signing happens client-side in
// F10 (PLAN.md §3.2.4 client-cli signer, §6.3 signer seam).
type BYOSigner struct{}

func (BYOSigner) Sign(_ context.Context, _ string, _ []byte) (Signature, error) {
	return Signature{}, ErrBYONotWired
}

func (BYOSigner) PublicKey(_ string) (ed25519.PublicKey, error) {
	return nil, ErrBYONotWired
}

// Compile-time assertion that BYOSigner satisfies the Signer interface. The
// same assertion lives on CustodialSigner via the test suite.
var _ Signer = BYOSigner{}
