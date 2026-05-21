package verify_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	receipt "github.com/goatnetwork/goatx402-receipt"
	"github.com/goatnetwork/goatx402-receipt/verify"
)

// fixedClock is the wall-clock the tests treat as "now". It is anchored a few
// seconds after the fixture's CompletedAt so the happy-path receipt sits well
// inside MaxAge and well outside MaxClockSkew.
var fixedClock = time.UnixMilli(1_715_600_005_000)

const (
	defaultMaxAge       = 5 * time.Minute
	defaultMaxClockSkew = 30 * time.Second
)

// baseReceipt returns a fully-populated CantonReceipt whose CompletedAt sits
// 3 s before fixedClock. The signature/hash fields are placeholders that the
// per-test sign helpers overwrite.
func baseReceipt() receipt.CantonReceipt {
	return receipt.CantonReceipt{
		Version:                  receipt.SchemaVersion,
		Domain:                   receipt.DomainV1,
		OrderID:                  "0190f7d2-1234-7890-abcd-1234567890ab",
		LedgerID:                 "participant-localnet",
		TransactionID:            "tx-deadbeef-0001",
		ContractID:               "00:Holding:merchant-001",
		PaymentRequestContractID: "00:PaymentRequest:0001",
		ParticipantPartyID:       "participant::1220abc",
		Merchant:                 "Merchant::1220abc",
		Payer:                    "Payer::1220abc",
		Amount:                   "1.5",
		Currency:                 "USD-canton",
		TrustedIssuer:            "Issuer::1220abc",
		Resource:                 "/resource",
		MerchantRequestID:        "abcdef0123456789abcdef0123",
		ExpiresAtHTTP:            1_715_600_000_000,
		ExpiresAtDaml:            1_715_600_030_000,
		SignatureScheme:          receipt.SignatureSchemeEd25519,
		CompletedAt:              fixedClock.Add(-3 * time.Second).UnixMilli(),
	}
}

// sign computes Canonical(r), signs it with priv, and writes the resulting
// signature and display-only receiptPayloadHash into the returned receipt.
func sign(t *testing.T, priv ed25519.PrivateKey, r receipt.CantonReceipt) receipt.CantonReceipt {
	t.Helper()
	canonical, err := r.Canonical()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	sig := ed25519.Sign(priv, canonical)
	digest := sha256.Sum256(canonical)
	r.Signature = base64.StdEncoding.EncodeToString(sig)
	r.ReceiptPayloadHash = base64.StdEncoding.EncodeToString(digest[:])
	return r
}

func mustKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey: %v", err)
	}
	return pub, priv
}

func defaultOpts() verify.VerifyOptions {
	return verify.VerifyOptions{
		Now:          fixedClock,
		MaxAge:       defaultMaxAge,
		MaxClockSkew: defaultMaxClockSkew,
	}
}

// TestVerify_HappyPath pins the success path: a valid receipt signed by the
// primary participant-operator key validates with the default options.
func TestVerify_HappyPath(t *testing.T) {
	pub, priv := mustKeypair(t)
	r := sign(t, priv, baseReceipt())
	if err := verify.Verify(r, pub, defaultOpts()); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

// TestVerify_TamperMatrix exhaustively enumerates §6.4's tamper-vector list:
// sig flipped, payload flipped, scheme changed, future-dated, txId swap,
// contractId swap, participantPartyId swap, receiptPayloadHash mismatch,
// trustedIssuer swap, merchantRequestId swap, plus the stale clock case
// surfaced in the §6.4 errors table. Each case asserts the specific sentinel
// error so a regression that collapses two failure modes into one is caught.
func TestVerify_TamperMatrix(t *testing.T) {
	pub, priv := mustKeypair(t)

	// mutate is applied after the signed-receipt baseline is constructed.
	// reSign indicates whether the mutation should be re-signed under priv
	// (for cases where we want a different error than ErrBadSignature to
	// surface — e.g. ErrFutureDated needs an otherwise-valid signature).
	cases := []struct {
		name   string
		mutate func(*receipt.CantonReceipt)
		reSign bool
		want   error
	}{
		{
			name: "sig flipped",
			mutate: func(r *receipt.CantonReceipt) {
				raw, err := base64.StdEncoding.DecodeString(r.Signature)
				if err != nil {
					panic(err)
				}
				raw[0] ^= 0x01
				r.Signature = base64.StdEncoding.EncodeToString(raw)
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "payload flipped (amount)",
			mutate: func(r *receipt.CantonReceipt) {
				r.Amount = "9999.0"
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "scheme changed",
			mutate: func(r *receipt.CantonReceipt) {
				r.SignatureScheme = "Ed25519ph"
			},
			want: verify.ErrUnsupportedScheme,
		},
		{
			name: "completedAt in future > MaxClockSkew",
			mutate: func(r *receipt.CantonReceipt) {
				r.CompletedAt = fixedClock.Add(2 * defaultMaxClockSkew).UnixMilli()
			},
			reSign: true,
			want:   verify.ErrFutureDated,
		},
		{
			name: "stale (completedAt + MaxAge < Now)",
			mutate: func(r *receipt.CantonReceipt) {
				r.CompletedAt = fixedClock.Add(-2 * defaultMaxAge).UnixMilli()
			},
			reSign: true,
			want:   verify.ErrStale,
		},
		{
			name: "txId swapped",
			mutate: func(r *receipt.CantonReceipt) {
				r.TransactionID = "tx-attacker-0001"
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "contractId swapped",
			mutate: func(r *receipt.CantonReceipt) {
				r.ContractID = "00:Holding:attacker-001"
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "participantPartyId swapped",
			mutate: func(r *receipt.CantonReceipt) {
				r.ParticipantPartyID = "participant::attacker"
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "receiptPayloadHash mismatch",
			mutate: func(r *receipt.CantonReceipt) {
				// Mutate the display-only hash without re-signing. The
				// signature is over canonical(r) (which excludes this field),
				// so the signature still validates but the hash diff fires.
				r.ReceiptPayloadHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
			},
			want: verify.ErrPayloadMismatch,
		},
		{
			name: "trustedIssuer swapped",
			mutate: func(r *receipt.CantonReceipt) {
				r.TrustedIssuer = "AttackerIssuer::1220abc"
			},
			want: verify.ErrBadSignature,
		},
		{
			name: "merchantRequestId swapped",
			mutate: func(r *receipt.CantonReceipt) {
				r.MerchantRequestID = "ffffffffffffffffffffffffff"
			},
			want: verify.ErrBadSignature,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := baseReceipt()
			if c.reSign {
				c.mutate(&r)
				r = sign(t, priv, r)
			} else {
				r = sign(t, priv, r)
				c.mutate(&r)
			}
			err := verify.Verify(r, pub, defaultOpts())
			if !errors.Is(err, c.want) {
				t.Fatalf("expected %v, got %v", c.want, err)
			}
		})
	}
}

// TestVerify_BadSignatureBase64 asserts that a malformed base64 signature
// surfaces as ErrBadSignature rather than panicking — boundary case of the
// "signature flipped" path.
func TestVerify_BadSignatureBase64(t *testing.T) {
	pub, priv := mustKeypair(t)
	r := sign(t, priv, baseReceipt())
	r.Signature = "%%%not-valid-base64%%%"
	if err := verify.Verify(r, pub, defaultOpts()); !errors.Is(err, verify.ErrBadSignature) {
		t.Fatalf("expected ErrBadSignature, got %v", err)
	}
}

// TestVerify_CanonicalErrorPropagated covers the Canonical() failure branch:
// an empty Domain bubbles up the receipt.ErrMissingDomain through Verify.
func TestVerify_CanonicalErrorPropagated(t *testing.T) {
	pub, priv := mustKeypair(t)
	r := sign(t, priv, baseReceipt())
	r.Domain = ""
	err := verify.Verify(r, pub, defaultOpts())
	if err == nil {
		t.Fatal("expected error from empty Domain, got nil")
	}
	if !errors.Is(err, receipt.ErrMissingDomain) {
		t.Fatalf("expected receipt.ErrMissingDomain, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Rotation / AcceptKeys window
// ---------------------------------------------------------------------------

// TestVerify_RotationAcceptKeyValidates asserts §6.4 (a): a receipt signed by
// AcceptKeys[0] verifies during the double-deploy window even though the
// primary participantPubKey differs.
func TestVerify_RotationAcceptKeyValidates(t *testing.T) {
	primaryPub, _ := mustKeypair(t)
	rotatedPub, rotatedPriv := mustKeypair(t)

	r := sign(t, rotatedPriv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{rotatedPub}
	if err := verify.Verify(r, primaryPub, opts); err != nil {
		t.Fatalf("expected nil during rotation window, got %v", err)
	}
}

// TestVerify_RotationUnknownKeyRejected asserts §6.4 (b): a receipt signed by
// a key that is neither the primary nor in AcceptKeys fails with
// ErrBadSignature.
func TestVerify_RotationUnknownKeyRejected(t *testing.T) {
	primaryPub, _ := mustKeypair(t)
	rotatedPub, _ := mustKeypair(t)
	_, attackerPriv := mustKeypair(t)

	r := sign(t, attackerPriv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{rotatedPub}
	if err := verify.Verify(r, primaryPub, opts); !errors.Is(err, verify.ErrBadSignature) {
		t.Fatalf("expected ErrBadSignature, got %v", err)
	}
}

// TestVerify_RotationTooManyAcceptKeys asserts §6.4 (c): AcceptKeys with more
// than one entry is rejected at construction time so a misconfigured
// trailing-key set cannot silently revert a completed rotation.
func TestVerify_RotationTooManyAcceptKeys(t *testing.T) {
	primaryPub, priv := mustKeypair(t)
	extraPub, _ := mustKeypair(t)
	anotherPub, _ := mustKeypair(t)

	r := sign(t, priv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{extraPub, anotherPub}
	if err := verify.Verify(r, primaryPub, opts); !errors.Is(err, verify.ErrTooManyAcceptKeys) {
		t.Fatalf("expected ErrTooManyAcceptKeys, got %v", err)
	}
}

// TestVerify_PrimaryStillWorksWithRotationConfigured pins the fall-through
// branch: a receipt signed by the primary key still validates when AcceptKeys
// is populated (we do not unconditionally fall through to the rotation slot).
func TestVerify_PrimaryStillWorksWithRotationConfigured(t *testing.T) {
	primaryPub, primaryPriv := mustKeypair(t)
	rotatedPub, _ := mustKeypair(t)

	r := sign(t, primaryPriv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{rotatedPub}
	if err := verify.Verify(r, primaryPub, opts); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

// TestVerify_ShortPrimaryKeyFallsThroughToAccept covers the branch where the
// primary key is structurally invalid (length != ed25519.PublicKeySize) but
// AcceptKeys carries the real key. ed25519.Verify returns false on the short
// key, and the fallback succeeds.
func TestVerify_ShortPrimaryKeyFallsThroughToAccept(t *testing.T) {
	rotatedPub, rotatedPriv := mustKeypair(t)
	r := sign(t, rotatedPriv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{rotatedPub}
	if err := verify.Verify(r, ed25519.PublicKey{0x00}, opts); err != nil {
		t.Fatalf("expected nil via AcceptKeys fallback, got %v", err)
	}
}

// TestVerify_ShortAcceptKeySkipped pins the structural-skip branch in
// verifyAgainstAny: a malformed AcceptKey (wrong length) must be ignored
// rather than crash ed25519.Verify, and the primary check still decides the
// outcome. Resolves the remaining branch in the rotation fallback.
func TestVerify_ShortAcceptKeySkipped(t *testing.T) {
	_, attackerPriv := mustKeypair(t)
	primaryPub, _ := mustKeypair(t)
	r := sign(t, attackerPriv, baseReceipt())

	opts := defaultOpts()
	opts.AcceptKeys = []ed25519.PublicKey{{0x00, 0x01, 0x02}} // structurally invalid
	if err := verify.Verify(r, primaryPub, opts); !errors.Is(err, verify.ErrBadSignature) {
		t.Fatalf("expected ErrBadSignature, got %v", err)
	}
}
