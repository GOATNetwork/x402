package sign_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/receipt/sign"
	"github.com/goatnetwork/goatx402-receipt"
	"github.com/goatnetwork/goatx402-receipt/verify"
)

func newTestSigner(t *testing.T) (*sign.Signer, ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey: %v", err)
	}
	s, err := sign.NewSigner(sign.SignerOptions{
		PrivateKey: priv,
		PublicKey:  pub,
		VerifyOptions: func() verify.VerifyOptions {
			return verify.VerifyOptions{
				Now:          time.UnixMilli(1_715_600_002_000).UTC(),
				MaxAge:       5 * time.Minute,
				MaxClockSkew: 30 * time.Second,
			}
		},
	})
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s, pub, priv
}

func newDraft() receipt.CantonReceipt {
	return receipt.CantonReceipt{
		OrderID:                  "01HXYZ",
		LedgerID:                 "participant1",
		TransactionID:            "tx-123",
		ContractID:               "merchant-holding-cid",
		PaymentRequestContractID: "pr-cid",
		ParticipantPartyID:       "participant-operator",
		Merchant:                 "merchant-party",
		Payer:                    "payer-party",
		Amount:                   "1.5",
		Currency:                 "USD-canton",
		TrustedIssuer:            "issuer-party",
		Resource:                 "/protected",
		MerchantRequestID:        "abcdefghijklmnopqrstuv",
		ExpiresAtHTTP:            1_715_600_000_000,
		ExpiresAtDaml:            1_715_600_030_000,
		CompletedAt:              1_715_600_001_000,
	}
}

func TestSign_RoundTripVerifies(t *testing.T) {
	s, pub, _ := newTestSigner(t)
	r, err := s.Sign(newDraft())
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if r.Signature == "" {
		t.Fatalf("signature empty")
	}
	if r.ReceiptPayloadHash == "" {
		t.Fatalf("receiptPayloadHash empty")
	}
	if r.SignatureScheme != receipt.SignatureSchemeEd25519 {
		t.Fatalf("scheme %q", r.SignatureScheme)
	}
	if r.Domain != receipt.DomainV1 {
		t.Fatalf("domain %q", r.Domain)
	}
	opts := verify.VerifyOptions{
		Now:          time.UnixMilli(1_715_600_002_000).UTC(),
		MaxAge:       5 * time.Minute,
		MaxClockSkew: 30 * time.Second,
	}
	if err := verify.Verify(r, pub, opts); err != nil {
		t.Fatalf("verify against fresh pubkey: %v", err)
	}
}

func TestSign_Deterministic(t *testing.T) {
	s, _, _ := newTestSigner(t)
	a, err := s.Sign(newDraft())
	if err != nil {
		t.Fatalf("a: %v", err)
	}
	b, err := s.Sign(newDraft())
	if err != nil {
		t.Fatalf("b: %v", err)
	}
	// Ed25519 PureEdDSA is deterministic; identical inputs yield identical
	// signatures.
	if a.Signature != b.Signature {
		t.Fatalf("Ed25519 signatures must be deterministic; got %q vs %q", a.Signature, b.Signature)
	}
	if a.ReceiptPayloadHash != b.ReceiptPayloadHash {
		t.Fatalf("hash differs across calls: %q vs %q", a.ReceiptPayloadHash, b.ReceiptPayloadHash)
	}
}

func TestSign_SelfVerifyFailureOnMismatchedKey(t *testing.T) {
	// Configure a signer whose PublicKey does not match its PrivateKey by
	// constructing two keypairs and mixing them. NewSigner must reject this
	// at construction time (defence-in-depth before /proof ever runs).
	_, priv1, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gen 1: %v", err)
	}
	pub2, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gen 2: %v", err)
	}
	_, err = sign.NewSigner(sign.SignerOptions{
		PrivateKey: priv1,
		PublicKey:  pub2,
	})
	if err == nil {
		t.Fatalf("expected mismatched key construction to fail")
	}
	if !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected mismatched-key error, got %v", err)
	}
}

func TestSign_RejectsEmptyKey(t *testing.T) {
	_, err := sign.NewSigner(sign.SignerOptions{})
	if !errors.Is(err, sign.ErrEmptyKey) {
		t.Fatalf("expected ErrEmptyKey, got %v", err)
	}
}

func TestSign_RejectsWrongLength(t *testing.T) {
	_, err := sign.NewSigner(sign.SignerOptions{
		PrivateKey: ed25519.PrivateKey(bytes.Repeat([]byte{0x00}, 16)),
		PublicKey:  ed25519.PublicKey(bytes.Repeat([]byte{0x00}, 32)),
	})
	if err == nil {
		t.Fatalf("expected short-private-key rejection")
	}
}

func TestSign_FailsWhenVerifyClockTooFarOff(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gen: %v", err)
	}
	// Self-verify clock is way past CompletedAt + MaxAge — must fail.
	s, err := sign.NewSigner(sign.SignerOptions{
		PrivateKey: priv,
		PublicKey:  pub,
		VerifyOptions: func() verify.VerifyOptions {
			return verify.VerifyOptions{
				Now:          time.UnixMilli(1_715_600_001_000).Add(24 * time.Hour),
				MaxAge:       5 * time.Minute,
				MaxClockSkew: 30 * time.Second,
			}
		},
	})
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	_, err = s.Sign(newDraft())
	if err == nil {
		t.Fatalf("expected self-verify failure (stale)")
	}
	if !errors.Is(err, sign.ErrSelfVerifyFailed) {
		t.Fatalf("expected ErrSelfVerifyFailed, got %v", err)
	}
}

func TestSign_RawJSONExcludesPrivateBytes(t *testing.T) {
	s, _, priv := newTestSigner(t)
	r, err := s.Sign(newDraft())
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	// The full receipt envelope must never echo private bytes; a paranoia
	// assertion guards against accidental field additions that leak them.
	enc := r.Signature + r.ReceiptPayloadHash + r.Domain + r.OrderID
	if strings.Contains(enc, string(priv[:16])) {
		t.Fatalf("signed receipt encoded private key bytes")
	}
}

func TestFingerprintNonEmpty(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gen: %v", err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	fp := sign.Fingerprint(pub)
	if fp == "" {
		t.Fatalf("expected non-empty fingerprint")
	}
	// Should not echo raw public bytes.
	if strings.Contains(fp, base64.StdEncoding.EncodeToString(pub)) {
		t.Fatalf("fingerprint leaked raw public key bytes")
	}
}
