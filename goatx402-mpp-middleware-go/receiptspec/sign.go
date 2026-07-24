package receiptspec

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"io"
)

// ErrSigVerifyFailed is returned by higher-level helpers when a
// signature does not match. The low-level VerifyEd25519 / VerifyHMAC
// return a boolean; callers wanting an error-shaped API can use this
// sentinel.
var ErrSigVerifyFailed = errors.New("receiptspec: signature verification failed")

// signingBytes writes the canonical binding-field byte sequence for r
// to w. The layout is length-prefixed framing for every
// variable-length field and fixed-width big-endian encoding for every
// numeric / timestamp field, in the following order:
//
//	receipt_id            : LP-string
//	challenge_id          : LP-string
//	order_id              : LP-string
//	merchant_id           : LP-string
//	payer_addr            : LP-string
//	chain_id              : int64 big-endian
//	token_contract        : LP-string
//	recipient             : LP-string
//	amount_wei            : LP-string (decimal string)
//	request_canonical     : LP-string
//	tx_hash               : LP-string
//	log_index             : uint64 big-endian
//	block_number          : int64 big-endian
//	block_timestamp       : int64 big-endian (Unix seconds)
//	receipt_issued_at     : int64 big-endian (Unix seconds)
//	receipt_expires_at    : int64 big-endian (Unix seconds)
//
// Length-prefixed framing is chosen over JSON-canonicalization because
// it has zero implementation variance across languages: a 4-byte
// big-endian length followed by raw bytes is unambiguous. JSON
// canonicalization, by contrast, has at least three competing
// specifications and has historically caused signature-validation bugs
// in multi-language ecosystems.
//
// This function is exported as a contract through SigningBytes; the
// unexported variant exists so callers do not need to allocate when
// streaming into a hash or HMAC.
//
// IMPORTANT: This layout is part of the on-wire contract. Any change
// requires a protocol version bump.
func signingBytes(w io.Writer, r Receipt) {
	writeLP(w, r.ReceiptID)
	writeLP(w, r.ChallengeID)
	writeLP(w, r.OrderID)
	writeLP(w, r.MerchantID)
	writeLP(w, r.PayerAddr)
	writeInt64(w, r.ChainID)
	writeLP(w, r.TokenContract)
	writeLP(w, r.Recipient)
	writeLP(w, r.AmountWei)
	writeLP(w, r.RequestCanonical)
	writeLP(w, r.TxHash)
	writeUint64(w, uint64(r.LogIndex))
	writeInt64(w, r.BlockNumber)
	writeInt64(w, r.BlockTimestamp.Unix())
	writeInt64(w, r.ReceiptIssuedAt.Unix())
	writeInt64(w, r.ReceiptExpiresAt.Unix())
}

// SigningBytes returns the canonical signing-byte sequence for r as a
// freshly allocated slice. This is convenient for tests, debugging,
// and callers that want to feed the bytes into a non-streaming
// primitive. Production verification should prefer the streaming
// helpers (VerifyEd25519, VerifyHMAC) which avoid the intermediate
// allocation.
func SigningBytes(r Receipt) []byte {
	buf := &byteBuffer{}
	signingBytes(buf, r)
	return buf.b
}

func writeLP(w io.Writer, s string) {
	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], uint32(len(s)))
	_, _ = w.Write(buf[:])
	_, _ = w.Write([]byte(s))
}

func writeInt64(w io.Writer, n int64) {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(n))
	_, _ = w.Write(buf[:])
}

func writeUint64(w io.Writer, n uint64) {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], n)
	_, _ = w.Write(buf[:])
}

// byteBuffer is a minimal io.Writer that appends to an internal slice.
// We avoid bytes.Buffer to keep the dependency surface as small as
// possible — this module is intended to be embeddable in size-sensitive
// downstream projects.
type byteBuffer struct{ b []byte }

func (bb *byteBuffer) Write(p []byte) (int, error) {
	bb.b = append(bb.b, p...)
	return len(p), nil
}

// VerifyEd25519 returns true iff sig is a valid ed25519 signature over
// r's canonical signing bytes under pub. The signing bytes are first
// hashed with SHA-256 and the fixed 32-byte digest is the message
// ed25519 verifies; ed25519 itself hashes again internally, so the
// outer SHA-256 is purely a domain-separation / message-size measure
// (it bounds the message ed25519 sees to 32 bytes regardless of
// receipt size, which makes batch-verify cost predictable). The
// issuing platform signs the same construction.
//
// ed25519.Verify is itself constant-time with respect to the public
// key and signature, so no additional timing hardening is required
// here.
//
// pub MUST be a valid 32-byte ed25519 public key. A nil or
// wrong-length key returns false (ed25519.Verify returns false rather
// than panicking on wrong-length public keys).
func VerifyEd25519(pub ed25519.PublicKey, r Receipt, sig []byte) bool {
	h := sha256.New()
	signingBytes(h, r)
	return ed25519.Verify(pub, h.Sum(nil), sig)
}

// hmacSum computes HMAC-SHA256(secret, signingBytes(r)); the MAC is 32
// bytes. secret MAY be of any length; HMAC-SHA256 internally rehashes
// over-long keys and zero-pads short ones, but operationally callers
// SHOULD use at least 32 random bytes.
//
// Unexported on purpose: this public copy of the receipt spec is
// verification-side only and does not expose issuance/signing APIs.
func hmacSum(secret []byte, r Receipt) []byte {
	mac := hmac.New(sha256.New, secret)
	signingBytes(mac, r)
	return mac.Sum(nil)
}

// VerifyHMAC returns true iff sig equals HMAC-SHA256(secret,
// signingBytes(r)). Comparison uses hmac.Equal, which is
// constant-time with respect to the secret-derived MAC. The issuing
// platform computes the same construction.
func VerifyHMAC(secret []byte, r Receipt, sig []byte) bool {
	expected := hmacSum(secret, r)
	return hmac.Equal(expected, sig)
}

// constantTimeEqual compares two strings in constant time. Exported
// only for internal use; available for tests that want to assert we
// pick constant-time primitives in security-relevant code paths.
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
