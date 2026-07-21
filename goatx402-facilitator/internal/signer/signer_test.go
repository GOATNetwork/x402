package signer

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Compile-time assertions; mirrored to BYOSigner inside byo.go.
var (
	_ Signer = (*CustodialSigner)(nil)
)

func writeCustodialKey(t *testing.T, dir, party string, priv ed25519.PrivateKey) {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("MarshalPKCS8PrivateKey: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	path := filepath.Join(dir, party+CustodialKeyFileSuffix)
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func writeRegistry(t *testing.T, path string, entries map[string]ed25519.PublicKey) {
	t.Helper()
	out := make(map[string]string, len(entries))
	for party, pk := range entries {
		out[party] = base64.StdEncoding.EncodeToString(pk)
	}
	data, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal registry: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write registry: %v", err)
	}
}

func newKeyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return pub, priv
}

func TestCustodialSigner_Sign_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	if got := s.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1", got)
	}

	msg := []byte("canonical submission bytes go here")
	sig, err := s.Sign(context.Background(), "alice", msg)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if sig.Scheme != SchemeEd25519 {
		t.Fatalf("scheme = %q, want %q", sig.Scheme, SchemeEd25519)
	}
	if len(sig.Bytes) != ed25519.SignatureSize {
		t.Fatalf("signature length = %d, want %d", len(sig.Bytes), ed25519.SignatureSize)
	}

	pub, err := s.PublicKey("alice")
	if err != nil {
		t.Fatalf("PublicKey: %v", err)
	}
	if !ed25519.Verify(pub, msg, sig.Bytes) {
		t.Fatalf("ed25519.Verify failed for fresh signature")
	}

	// PureEdDSA over Ed25519 is deterministic — same message + key MUST yield
	// the same signature byte-for-byte.
	sig2, err := s.Sign(context.Background(), "alice", msg)
	if err != nil {
		t.Fatalf("Sign (second call): %v", err)
	}
	if !bytes.Equal(sig.Bytes, sig2.Bytes) {
		t.Fatalf("Ed25519 sign should be deterministic; got two different signatures")
	}
}

func TestCustodialSigner_Sign_EmptyMessage(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	_, err = s.Sign(context.Background(), "alice", nil)
	if !errors.Is(err, ErrEmptyMessage) {
		t.Fatalf("Sign(empty) err = %v, want ErrEmptyMessage", err)
	}
}

func TestCustodialSigner_Sign_UnknownParty(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	_, err = s.Sign(context.Background(), "bob", []byte("msg"))
	if !errors.Is(err, ErrPartyNotFound) {
		t.Fatalf("Sign(bob) err = %v, want ErrPartyNotFound", err)
	}
	_, err = s.PublicKey("bob")
	if !errors.Is(err, ErrPartyNotFound) {
		t.Fatalf("PublicKey(bob) err = %v, want ErrPartyNotFound", err)
	}
}

func TestCustodialSigner_Sign_ContextCancelled(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.Sign(ctx, "alice", []byte("msg"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Sign with cancelled ctx err = %v, want context.Canceled", err)
	}
}

func TestLoadCustodialSigner_MissingDir(t *testing.T) {
	_, err := LoadCustodialSigner(filepath.Join(t.TempDir(), "nonexistent"))
	if err == nil {
		t.Fatalf("expected error for missing dir")
	}
	if !strings.Contains(err.Error(), "custodial signer") {
		t.Fatalf("expected wrapped custodial signer error, got %v", err)
	}
}

func TestLoadCustodialSigner_EmptyPath(t *testing.T) {
	_, err := LoadCustodialSigner("")
	if err == nil {
		t.Fatalf("expected error for empty path")
	}
}

func TestLoadCustodialSigner_MalformedPEM(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "alice"+CustodialKeyFileSuffix)
	if err := os.WriteFile(path, []byte("not a pem block"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := LoadCustodialSigner(dir)
	if err == nil {
		t.Fatalf("expected error for malformed PEM")
	}
}

func TestLoadCustodialSigner_WrongKeyKind(t *testing.T) {
	dir := t.TempDir()
	// Write an RSA-style PKCS#8 PEM via raw bytes that will round-trip through
	// pem.Decode but fail x509.ParsePKCS8PrivateKey or fall through to the
	// "not an Ed25519 private key" branch. Easiest path: a random Ed25519
	// public key PEM block tagged PRIVATE KEY (will fail PKCS#8 parse).
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte{0, 1, 2, 3}})
	path := filepath.Join(dir, "alice"+CustodialKeyFileSuffix)
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := LoadCustodialSigner(dir)
	if err == nil {
		t.Fatalf("expected parse error for bogus PKCS#8")
	}
}

func TestLoadCustodialSigner_IgnoresUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	// Files that must be ignored by the loader.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi"), 0o600); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".hidden"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write hidden: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	if got := s.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1", got)
	}
}

func TestPayerKeyRegistry_Lookup(t *testing.T) {
	dir := t.TempDir()
	pubA, _ := newKeyPair(t)
	pubB, _ := newKeyPair(t)
	path := filepath.Join(dir, "registry.json")
	writeRegistry(t, path, map[string]ed25519.PublicKey{"alice": pubA, "bob": pubB})

	reg, err := NewPayerKeyRegistry(path)
	if err != nil {
		t.Fatalf("NewPayerKeyRegistry: %v", err)
	}
	if got := reg.Len(); got != 2 {
		t.Fatalf("Len = %d, want 2", got)
	}

	got, err := reg.PublicKey("alice")
	if err != nil {
		t.Fatalf("PublicKey(alice): %v", err)
	}
	if !bytes.Equal(got, pubA) {
		t.Fatalf("pubkey mismatch for alice")
	}

	_, err = reg.PublicKey("charlie")
	if !errors.Is(err, ErrPartyNotFound) {
		t.Fatalf("PublicKey(charlie) err = %v, want ErrPartyNotFound", err)
	}

	wantParties := []string{"alice", "bob"}
	gotParties := reg.Parties()
	if len(gotParties) != len(wantParties) {
		t.Fatalf("Parties = %v, want %v", gotParties, wantParties)
	}
	for i := range wantParties {
		if gotParties[i] != wantParties[i] {
			t.Fatalf("Parties[%d] = %q, want %q", i, gotParties[i], wantParties[i])
		}
	}
}

func TestPayerKeyRegistry_EmptyPath(t *testing.T) {
	_, err := NewPayerKeyRegistry("")
	if err == nil {
		t.Fatalf("expected error for empty path")
	}
}

func TestPayerKeyRegistry_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	if err := os.WriteFile(path, []byte("   \n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := NewPayerKeyRegistry(path)
	if err == nil {
		t.Fatalf("expected error for empty file")
	}
}

func TestPayerKeyRegistry_MalformedBase64(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	if err := os.WriteFile(path, []byte(`{"alice":"!!!not base64!!!"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := NewPayerKeyRegistry(path)
	if err == nil {
		t.Fatalf("expected base64 decode error")
	}
}

func TestPayerKeyRegistry_WrongKeyLength(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	// 16-byte key (too short for Ed25519).
	short := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 16))
	body := []byte(`{"alice":"` + short + `"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := NewPayerKeyRegistry(path)
	if !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("err = %v, want ErrInvalidKey", err)
	}
}

func TestPayerKeyRegistry_DuplicateKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	pub, _ := newKeyPair(t)
	b64 := base64.StdEncoding.EncodeToString(pub)
	body := []byte(`{"alice":"` + b64 + `","alice":"` + b64 + `"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := NewPayerKeyRegistry(path)
	if err == nil || !strings.Contains(err.Error(), "duplicate party id") {
		t.Fatalf("err = %v, want duplicate party id rejection", err)
	}
}

func TestPayerKeyRegistry_EmptyPartyID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	pub, _ := newKeyPair(t)
	b64 := base64.StdEncoding.EncodeToString(pub)
	body := []byte(`{"":"` + b64 + `"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := NewPayerKeyRegistry(path)
	if err == nil || !strings.Contains(err.Error(), "empty party id") {
		t.Fatalf("err = %v, want empty party id rejection", err)
	}
}

func TestBYOSigner_NotWired(t *testing.T) {
	var s Signer = BYOSigner{}
	_, err := s.Sign(context.Background(), "alice", []byte("x"))
	if !errors.Is(err, ErrBYONotWired) {
		t.Fatalf("Sign err = %v, want ErrBYONotWired", err)
	}
	_, err = s.PublicKey("alice")
	if !errors.Is(err, ErrBYONotWired) {
		t.Fatalf("PublicKey err = %v, want ErrBYONotWired", err)
	}
}

// TestSignErrorRedaction asserts the signer's error path never leaks key
// material. The §9.2 deep-walk log redaction is enforced at the log middleware
// in Task 10; here we cover the upstream invariant that the signer's *error
// string itself* contains no raw secret bytes — so the redaction list does
// not have to learn signer-specific field names to stay safe.
func TestSignErrorRedaction(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)

	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}

	// Capture any default-slog writes the signer might attempt.
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, nil)))
	defer slog.SetDefault(prev)

	sig, err := s.Sign(context.Background(), "alice", []byte("msg"))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if logBuf.Len() != 0 {
		t.Fatalf("signer must not log; captured: %q", logBuf.String())
	}

	// Trigger the unknown-party error path and assert the message contains
	// neither the raw private key bytes nor the raw public key bytes.
	_, errMissing := s.Sign(context.Background(), "bob", []byte("msg"))
	if errMissing == nil {
		t.Fatalf("expected error")
	}
	msg := errMissing.Error()
	if bytes.Contains([]byte(msg), priv) {
		t.Fatalf("error message contains raw private key bytes")
	}
	if bytes.Contains([]byte(msg), priv.Public().(ed25519.PublicKey)) {
		t.Fatalf("error message contains raw public key bytes")
	}
	if bytes.Contains([]byte(msg), sig.Bytes) {
		t.Fatalf("error message contains signature bytes")
	}
}
