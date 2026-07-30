// Package receiptspec defines the canonical on-wire format, deterministic
// identifier derivation, and signature primitives for the GOAT Flow MPP
// (Machine Payments Protocol) Payment-Receipt.
//
// # Bundling note
//
// This package is bundled with the source-only Go middleware module so an
// application needs only one local `replace` directive for the x402 repository
// checkout. It is the Go source of the receipt contract used by this middleware.
//
// The signing-bytes layout, field order, and ID derivation are by
// design immutable until the protocol version is bumped.
// TestSigningBytes_GoldenFixture (sign_golden_test.go) pins this package's
// SigningBytes output to the hand-verified golden hex used by the TS
// cross-validation fixture, so a drift fails the build here rather than
// silently shipping a receipt the rest of the ecosystem rejects.
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
