// Package receiptspec defines the canonical on-wire format, deterministic
// identifier derivation, and signature primitives for the GOAT Flow MPP
// (Merchant Payment Protocol) Payment-Receipt.
//
// # Vendoring note (Round-17 codex P2)
//
// This package is a BYTE-FOR-BYTE MIRROR of the standalone
// github.com/goatnetwork/goatflow-mpp-receipt-spec module. The mirror
// exists because go.mod `replace` directives are not honoured for
// downstream consumers; without the in-module copy the public
// middleware library would not be `go get`-able outside the monorepo.
//
// The signing-bytes layout, field order, and ID derivation are by
// design immutable until the protocol version is bumped; any change
// to this package must land identically in the standalone module
// (and vice versa). TestSigningBytes_GoldenFixture (sign_golden_test.go)
// pins this copy's SigningBytes output to the SAME hand-verified golden
// hex used by the standalone module and the TS cross-validate fixture, so
// a drift in this copy fails the build here rather than silently shipping a
// receipt the rest of the ecosystem rejects.
//
// # Purpose
//
// A Payment-Receipt is the signed value object that x402d issues after a
// payment has settled on chain. Merchant resource servers (or middleware
// libraries) verify the signature before granting access to the protected
// resource the buyer paid for. Because the receipt crosses a trust
// boundary (platform -> merchant) and is consumed by multiple
// implementations (Core in Go, middleware in Go/TS/Python/...), the
// encoding, field ordering, and signing-bytes layout defined here are a
// STABLE ON-WIRE CONTRACT.
//
// # Stability Guarantee
//
// The following are versioned and MUST NOT change without a corresponding
// protocol version bump (which would also force every deployed verifier to
// upgrade):
//
//   - The set and order of binding fields in Receipt (see receipt.go).
//   - The length-prefixed framing layout in signingBytes (see sign.go).
//   - The DeriveReceiptID hash construction (see id.go).
//   - The wire encodings EncodeHeader / EncodeEnvelope (see encode.go).
//
// # Module Boundary
//
// This module deliberately depends only on the Go standard library so it
// can be safely vendored by external merchant integrations. It MUST NOT
// import any goatx402-core internal package; doing so would create a
// cyclic dependency and pull operational concerns into a public contract
// module.
package receiptspec
