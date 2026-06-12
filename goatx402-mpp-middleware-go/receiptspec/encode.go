package receiptspec

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Algorithm names the signature algorithm used to authenticate a
// Receipt. Verifiers MUST reject unknown algorithm strings.
type Algorithm string

const (
	// AlgEd25519 is the platform-wide ed25519 signature scheme. The
	// signature is 64 bytes; the verifier key is the published
	// platform public key.
	AlgEd25519 Algorithm = "ed25519"

	// AlgHMACSHA256 is the per-merchant shared-secret scheme. The
	// signature is 32 bytes; the verifier key is the merchant's
	// shared secret.
	AlgHMACSHA256 Algorithm = "hmac-sha256"
)

// IsValid reports whether a is one of the registered algorithm
// identifiers. Unknown algorithms MUST be rejected at the verifier;
// this helper centralises that check.
func (a Algorithm) IsValid() bool {
	switch a {
	case AlgEd25519, AlgHMACSHA256:
		return true
	default:
		return false
	}
}

// Errors returned by the encoding layer. All decode errors are
// surfaced as wrapped variants of these sentinels so callers can do
// errors.Is checks without parsing message strings.
var (
	// ErrMalformedHeader indicates the Payment-Receipt header did not
	// have the expected three-part dot-separated structure or a part
	// was not valid base64url / JSON.
	ErrMalformedHeader = errors.New("receiptspec: malformed Payment-Receipt header")

	// ErrMalformedEnvelope indicates a JSON-envelope body could not be
	// decoded strictly (unknown fields or invalid JSON).
	ErrMalformedEnvelope = errors.New("receiptspec: malformed receipt envelope")

	// ErrUnknownAlgorithm indicates the algorithm field carried a
	// value that is not in the registered set.
	ErrUnknownAlgorithm = errors.New("receiptspec: unknown algorithm")
)

// EncodeHeader returns the on-wire form of a Payment-Receipt HTTP
// header value:
//
//	<base64url(JSON(receipt))> "." <base64url(sig)> "." <algorithm>
//
// where every base64url encoding uses base64.RawURLEncoding (no
// padding). The algorithm part is the plain ASCII algorithm identifier
// (e.g. "ed25519"). The dot separator is chosen for visual similarity
// to JWT and because it never appears in base64url alphabet or in any
// registered algorithm name.
//
// EncodeHeader does NOT call r.Validate; callers are expected to
// validate before signing so the wire form already commits to a
// validated structure.
func EncodeHeader(r Receipt, sig []byte, alg Algorithm) (string, error) {
	if !alg.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrUnknownAlgorithm, alg)
	}
	body, err := json.Marshal(r)
	if err != nil {
		return "", fmt.Errorf("receiptspec: marshal receipt: %w", err)
	}
	var sb strings.Builder
	sb.Grow(base64.RawURLEncoding.EncodedLen(len(body)) + 1 +
		base64.RawURLEncoding.EncodedLen(len(sig)) + 1 + len(alg))
	sb.WriteString(base64.RawURLEncoding.EncodeToString(body))
	sb.WriteByte('.')
	sb.WriteString(base64.RawURLEncoding.EncodeToString(sig))
	sb.WriteByte('.')
	sb.WriteString(string(alg))
	return sb.String(), nil
}

// DecodeHeader parses a Payment-Receipt header value produced by
// EncodeHeader. It validates the three-part structure, the base64url
// encoding of both binary parts, the algorithm identifier, and uses
// strict JSON decoding (DisallowUnknownFields) so receivers reject
// receipts with extra fields the spec does not recognise — this
// protects against downgrade-style attacks where an attacker hides
// extra data outside the binding-field set.
//
// On error the returned Receipt is the zero value and sig is nil.
func DecodeHeader(header string) (Receipt, []byte, Algorithm, error) {
	parts := strings.Split(header, ".")
	if len(parts) != 3 {
		return Receipt{}, nil, "", fmt.Errorf("%w: expected 3 dot-separated parts, got %d", ErrMalformedHeader, len(parts))
	}
	bodyB64, sigB64, algStr := parts[0], parts[1], parts[2]

	alg := Algorithm(algStr)
	if !alg.IsValid() {
		return Receipt{}, nil, "", fmt.Errorf("%w: %q", ErrUnknownAlgorithm, algStr)
	}

	body, err := base64.RawURLEncoding.DecodeString(bodyB64)
	if err != nil {
		return Receipt{}, nil, "", fmt.Errorf("%w: receipt part not valid base64url: %v", ErrMalformedHeader, err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return Receipt{}, nil, "", fmt.Errorf("%w: signature part not valid base64url: %v", ErrMalformedHeader, err)
	}

	var r Receipt
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return Receipt{}, nil, "", fmt.Errorf("%w: receipt JSON: %v", ErrMalformedHeader, err)
	}
	// json.Decoder.More() reports false for pure-delimiter trailing
	// tokens like `}` or `]` (it considers them part of the parent
	// container, not "more values"), so a body of `{...}}` slips past
	// it. Explicitly request the next token and require io.EOF.
	var junk json.RawMessage
	if err := dec.Decode(&junk); err != io.EOF {
		if err == nil {
			return Receipt{}, nil, "", fmt.Errorf("%w: trailing data after receipt JSON", ErrMalformedHeader)
		}
		return Receipt{}, nil, "", fmt.Errorf("%w: expected EOF after receipt JSON: %v", ErrMalformedHeader, err)
	}
	return r, sig, alg, nil
}

// Envelope is the JSON-body form of a signed receipt. It is used
// (for example) in retry POST bodies where a single header is
// awkward or where the receipt may be embedded in a larger document
// structure later.
type Envelope struct {
	// Receipt is the full receipt value object.
	Receipt Receipt `json:"receipt"`

	// Signature is the base64url (no padding) encoding of the raw
	// signature bytes (ed25519: 64 bytes; HMAC-SHA256: 32 bytes).
	Signature string `json:"signature"`

	// Algorithm names the signing scheme; see Algorithm constants.
	Algorithm Algorithm `json:"algorithm"`
}

// EncodeEnvelope marshals (r, sig, alg) to its JSON envelope wire
// form. The output is canonical JSON in the sense that field order is
// determined by Go's encoding/json, which is stable across Go
// versions; for byte-exact stability across language implementations
// rely on the signing-bytes layout, not the JSON envelope.
func EncodeEnvelope(r Receipt, sig []byte, alg Algorithm) ([]byte, error) {
	if !alg.IsValid() {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAlgorithm, alg)
	}
	env := Envelope{
		Receipt:   r,
		Signature: base64.RawURLEncoding.EncodeToString(sig),
		Algorithm: alg,
	}
	return json.Marshal(env)
}

// DecodeEnvelope parses a JSON envelope body. Decoding is strict:
// unknown fields at either the top level or inside Receipt cause the
// call to fail with a wrapped ErrMalformedEnvelope. This mirrors
// DecodeHeader and is the recommended posture for any verifier that
// will use the receipt to gate access to resources.
//
// On error the returned Receipt is the zero value and sig is nil.
func DecodeEnvelope(data []byte) (Receipt, []byte, Algorithm, error) {
	var env Envelope
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return Receipt{}, nil, "", fmt.Errorf("%w: %v", ErrMalformedEnvelope, err)
	}
	// dec.More() returns false for pure-delimiter trailing tokens
	// like `}` (the decoder considers them container-internal), so a
	// payload of `{...}}` would otherwise pass. Asking for an explicit
	// next decode and requiring io.EOF catches that and any other
	// trailing junk after the canonical envelope.
	var junk json.RawMessage
	if err := dec.Decode(&junk); err != io.EOF {
		if err == nil {
			return Receipt{}, nil, "", fmt.Errorf("%w: trailing data after JSON envelope", ErrMalformedEnvelope)
		}
		return Receipt{}, nil, "", fmt.Errorf("%w: expected EOF after JSON envelope: %v", ErrMalformedEnvelope, err)
	}
	if !env.Algorithm.IsValid() {
		return Receipt{}, nil, "", fmt.Errorf("%w: %q", ErrUnknownAlgorithm, env.Algorithm)
	}
	sig, err := base64.RawURLEncoding.DecodeString(env.Signature)
	if err != nil {
		return Receipt{}, nil, "", fmt.Errorf("%w: signature not valid base64url: %v", ErrMalformedEnvelope, err)
	}
	return env.Receipt, sig, env.Algorithm, nil
}
