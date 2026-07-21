package signer

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// CustodialKeyFileSuffix is the extension scripts/init-custodial-keys.sh
// writes (PLAN.md Task 6). Each file is a PEM-encoded PKCS#8 Ed25519 private
// key, chmod 600. PEM is the format `openssl genpkey -algorithm Ed25519`
// emits natively, which keeps the bootstrap script portable and removes any
// custom binary parsing from bash.
const CustodialKeyFileSuffix = ".ed25519"

// CanaryMessage is the fixed canary the boot self-check signs and verifies.
// Domain-separated from receipt and submission preimages so the canary can
// never be replayed as a real signature on the wire (PLAN.md §6.3).
const CanaryMessage = "goat-canton-payment:signer-boot-self-check:v1"

// CustodialSigner is the v0 in-process custodial signer. It loads per-payer
// keys at construction time and never re-reads the directory; rotation
// requires a rolling restart (PLAN.md §5.5 PAYER_TOKEN_FILE rotation note,
// same lifecycle).
type CustodialSigner struct {
	keys map[string]ed25519.PrivateKey
}

// LoadCustodialSigner walks dir, decodes every <party>.ed25519 file, and
// returns a signer keyed by partyId.
//
// The PEM type must be "PRIVATE KEY" (PKCS#8). The directory itself is not
// required to be present — an empty dir is a programming bug at v0 (no parties
// to sign for) but is reported with a clear error.
func LoadCustodialSigner(dir string) (*CustodialSigner, error) {
	if dir == "" {
		return nil, errors.New("custodial signer: CUSTODIAL_KEY_DIR is empty")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("custodial signer: stat %s: %w", dir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("custodial signer: %s is not a directory", dir)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("custodial signer: read dir %s: %w", dir, err)
	}
	keys := make(map[string]ed25519.PrivateKey)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, CustodialKeyFileSuffix) {
			continue
		}
		party := strings.TrimSuffix(name, CustodialKeyFileSuffix)
		if party == "" {
			continue
		}
		path := filepath.Join(dir, name)
		priv, err := readCustodialKey(path)
		if err != nil {
			return nil, fmt.Errorf("custodial signer: party %s: %w", party, err)
		}
		keys[party] = priv
	}
	return &CustodialSigner{keys: keys}, nil
}

func readCustodialKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("read %s: no PEM block found", path)
	}
	if block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("read %s: unexpected PEM type %q, want PRIVATE KEY", path, block.Type)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("read %s: parse PKCS#8: %w", path, err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("read %s: not an Ed25519 private key (got %T)", path, key)
	}
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("read %s: %w (have %d bytes, want %d)",
			path, ErrInvalidKey, len(priv), ed25519.PrivateKeySize)
	}
	return priv, nil
}

// Sign signs message with party's custodial private key using PureEdDSA.
// message MUST be the full canonical bytes (e.g. pkg/receipt.CanonicalSubmission
// output); the signer never accepts a pre-computed digest.
func (c *CustodialSigner) Sign(ctx context.Context, party string, message []byte) (Signature, error) {
	if c == nil {
		return Signature{}, ErrPartyNotFound
	}
	if len(message) == 0 {
		return Signature{}, ErrEmptyMessage
	}
	priv, ok := c.keys[party]
	if !ok {
		return Signature{}, fmt.Errorf("%w: %s", ErrPartyNotFound, party)
	}
	if err := ctx.Err(); err != nil {
		return Signature{}, err
	}
	sig := ed25519.Sign(priv, message)
	return Signature{Scheme: SchemeEd25519, Bytes: sig}, nil
}

// PublicKey returns the public half of party's custodial key.
func (c *CustodialSigner) PublicKey(party string) (ed25519.PublicKey, error) {
	if c == nil {
		return nil, ErrPartyNotFound
	}
	priv, ok := c.keys[party]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrPartyNotFound, party)
	}
	pk, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("party %s: %w (Public() returned %T)", party, ErrInvalidKey, priv.Public())
	}
	return pk, nil
}

// Parties returns the loaded party ids in deterministic order.
func (c *CustodialSigner) Parties() []string {
	if c == nil {
		return nil
	}
	out := make([]string, 0, len(c.keys))
	for k := range c.keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Len returns the number of loaded keys.
func (c *CustodialSigner) Len() int {
	if c == nil {
		return 0
	}
	return len(c.keys)
}

// VerifyAgainstRegistry implements the boot-time key-pair self-check (PLAN.md
// §6.3). For every party present in CUSTODIAL_KEY_DIR it signs CanaryMessage
// with the private key and verifies the signature against the registry's
// public key for the same party. Any mismatch fails fast with a
// KEY_BINDING_MISMATCH-wrapped error naming the offending partyId.
//
// Operator-facing rationale: without this gate, /custodial-sign silently
// produces signatures that /calldata-signature then rejects as
// INVALID_SIGNATURE (intentionally opaque). The boot gate moves the
// diagnostic from runtime to startup.
func (c *CustodialSigner) VerifyAgainstRegistry(reg *PayerKeyRegistry) error {
	if c == nil {
		return errors.New("custodial signer: nil signer")
	}
	if reg == nil {
		return errors.New("custodial signer: nil registry")
	}
	for _, party := range c.Parties() {
		priv := c.keys[party]
		sig := ed25519.Sign(priv, []byte(CanaryMessage))
		pub, err := reg.PublicKey(party)
		if err != nil {
			return fmt.Errorf("%w: partyId=%s: registry missing public key", ErrRegistryMismatch, party)
		}
		if !ed25519.Verify(pub, []byte(CanaryMessage), sig) {
			return fmt.Errorf("%w: partyId=%s: custodial private key does not match registry public key",
				ErrRegistryMismatch, party)
		}
	}
	return nil
}
