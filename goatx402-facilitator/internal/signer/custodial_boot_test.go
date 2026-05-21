package signer

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVerifyAgainstRegistry_Happy covers the boot-time key-pair self-check
// success path: every custodial private key signs the canary, and the
// registry's public key verifies it.
func TestVerifyAgainstRegistry_Happy(t *testing.T) {
	dir := t.TempDir()
	regPath := filepath.Join(dir, "registry.json")

	keyDir := filepath.Join(dir, "keys")
	if err := mkAll(keyDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	pubA, privA := newKeyPair(t)
	pubB, privB := newKeyPair(t)
	writeCustodialKey(t, keyDir, "alice", privA)
	writeCustodialKey(t, keyDir, "bob", privB)
	writeRegistry(t, regPath, map[string]ed25519.PublicKey{
		"alice": pubA,
		"bob":   pubB,
	})

	signer, err := LoadCustodialSigner(keyDir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	reg, err := NewPayerKeyRegistry(regPath)
	if err != nil {
		t.Fatalf("NewPayerKeyRegistry: %v", err)
	}
	if err := signer.VerifyAgainstRegistry(reg); err != nil {
		t.Fatalf("VerifyAgainstRegistry: %v", err)
	}
}

// TestVerifyAgainstRegistry_Mismatch is the canonical KEY_BINDING_MISMATCH
// boot-fail case: the registry advertises a public key whose private half is
// NOT the one in CUSTODIAL_KEY_DIR. The boot gate must fail fast and name the
// offending partyId.
func TestVerifyAgainstRegistry_Mismatch(t *testing.T) {
	dir := t.TempDir()
	regPath := filepath.Join(dir, "registry.json")

	keyDir := filepath.Join(dir, "keys")
	if err := mkAll(keyDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	pubA, privA := newKeyPair(t)
	_, privB := newKeyPair(t)
	pubWrong, _ := newKeyPair(t) // unrelated key bound to bob in the registry

	writeCustodialKey(t, keyDir, "alice", privA)
	writeCustodialKey(t, keyDir, "bob", privB)
	writeRegistry(t, regPath, map[string]ed25519.PublicKey{
		"alice": pubA,
		"bob":   pubWrong, // wrong public key for bob
	})

	signer, err := LoadCustodialSigner(keyDir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	reg, err := NewPayerKeyRegistry(regPath)
	if err != nil {
		t.Fatalf("NewPayerKeyRegistry: %v", err)
	}

	err = signer.VerifyAgainstRegistry(reg)
	if !errors.Is(err, ErrRegistryMismatch) {
		t.Fatalf("VerifyAgainstRegistry err = %v, want ErrRegistryMismatch", err)
	}
	if !strings.Contains(err.Error(), "partyId=bob") {
		t.Fatalf("error must name offending partyId; got %q", err.Error())
	}
}

// TestVerifyAgainstRegistry_MissingRegistryEntry covers the case where a
// custodial private key is present for a party that has no registry row.
// Boot must fail fast — proceeding would mean /custodial-sign hands out
// signatures /calldata-signature has no chance of verifying.
func TestVerifyAgainstRegistry_MissingRegistryEntry(t *testing.T) {
	dir := t.TempDir()
	regPath := filepath.Join(dir, "registry.json")
	keyDir := filepath.Join(dir, "keys")
	if err := mkAll(keyDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	pubA, privA := newKeyPair(t)
	_, privOrphan := newKeyPair(t)

	writeCustodialKey(t, keyDir, "alice", privA)
	writeCustodialKey(t, keyDir, "orphan", privOrphan)
	writeRegistry(t, regPath, map[string]ed25519.PublicKey{
		"alice": pubA,
		// "orphan" intentionally absent
	})

	signer, err := LoadCustodialSigner(keyDir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	reg, err := NewPayerKeyRegistry(regPath)
	if err != nil {
		t.Fatalf("NewPayerKeyRegistry: %v", err)
	}

	err = signer.VerifyAgainstRegistry(reg)
	if !errors.Is(err, ErrRegistryMismatch) {
		t.Fatalf("err = %v, want ErrRegistryMismatch", err)
	}
	if !strings.Contains(err.Error(), "partyId=orphan") {
		t.Fatalf("error must name offending partyId; got %q", err.Error())
	}
}

// TestVerifyAgainstRegistry_EmptyDir is the "no custodial parties" case
// (e.g. CANTON_PROD=true). VerifyAgainstRegistry must report success without
// touching the registry — there is nothing to verify.
func TestVerifyAgainstRegistry_EmptyDir(t *testing.T) {
	dir := t.TempDir()
	regPath := filepath.Join(dir, "registry.json")
	keyDir := filepath.Join(dir, "keys")
	if err := mkAll(keyDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pubA, _ := newKeyPair(t)
	writeRegistry(t, regPath, map[string]ed25519.PublicKey{"alice": pubA})

	signer, err := LoadCustodialSigner(keyDir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	if signer.Len() != 0 {
		t.Fatalf("expected 0 custodial keys, got %d", signer.Len())
	}
	reg, err := NewPayerKeyRegistry(regPath)
	if err != nil {
		t.Fatalf("NewPayerKeyRegistry: %v", err)
	}
	if err := signer.VerifyAgainstRegistry(reg); err != nil {
		t.Fatalf("VerifyAgainstRegistry on empty dir: %v", err)
	}
}

func TestVerifyAgainstRegistry_NilRegistry(t *testing.T) {
	dir := t.TempDir()
	_, priv := newKeyPair(t)
	writeCustodialKey(t, dir, "alice", priv)
	s, err := LoadCustodialSigner(dir)
	if err != nil {
		t.Fatalf("LoadCustodialSigner: %v", err)
	}
	if err := s.VerifyAgainstRegistry(nil); err == nil {
		t.Fatalf("expected error for nil registry")
	}
}

func mkAll(path string) error {
	return os.MkdirAll(path, 0o700)
}
