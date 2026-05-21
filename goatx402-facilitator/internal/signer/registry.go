package signer

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// PayerKeyRegistry is the canonical "payer party → public key" binding used by
// /calldata-signature to authenticate the payer's Ed25519 signature. The
// client-supplied publicKey field is rejected if it disagrees with the value
// returned here (PLAN.md §5.5 / §6.3).
//
// The registry is loaded once at boot and held in process memory; rotation
// requires a rolling restart (acceptable for v0; see PAYER_TOKEN_FILE rotation
// note in §5.5).
type PayerKeyRegistry struct {
	keys map[string]ed25519.PublicKey
}

// NewPayerKeyRegistry parses PAYER_KEY_REGISTRY_PATH. The file is a JSON object
// mapping Canton party id to a base64-encoded raw 32-byte Ed25519 public key
// (the format scripts/init-custodial-keys.sh writes). Duplicate keys are
// rejected by the json decoder via DisallowUnknownFields-equivalent: we run
// json.Decoder with a separate duplicate-key sweep, since encoding/json
// silently coalesces duplicates by default.
func NewPayerKeyRegistry(path string) (*PayerKeyRegistry, error) {
	if path == "" {
		return nil, fmt.Errorf("payer key registry: path is empty")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("payer key registry: read %s: %w", path, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, fmt.Errorf("payer key registry: %s is empty", path)
	}

	if err := assertNoDuplicateKeys(data); err != nil {
		return nil, fmt.Errorf("payer key registry: %s: %w", path, err)
	}

	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("payer key registry: parse %s: %w", path, err)
	}

	keys := make(map[string]ed25519.PublicKey, len(raw))
	for party, b64 := range raw {
		if party == "" {
			return nil, fmt.Errorf("payer key registry: %s: empty party id", path)
		}
		pkBytes, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("payer key registry: party %s: base64 decode: %w", party, err)
		}
		if len(pkBytes) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("payer key registry: party %s: %w (have %d bytes, want %d)",
				party, ErrInvalidKey, len(pkBytes), ed25519.PublicKeySize)
		}
		pk := make(ed25519.PublicKey, ed25519.PublicKeySize)
		copy(pk, pkBytes)
		keys[party] = pk
	}
	return &PayerKeyRegistry{keys: keys}, nil
}

// PublicKey returns the public key registered for party. The error wraps
// ErrPartyNotFound so callers can use errors.Is.
func (r *PayerKeyRegistry) PublicKey(party string) (ed25519.PublicKey, error) {
	if r == nil {
		return nil, ErrPartyNotFound
	}
	pk, ok := r.keys[party]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrPartyNotFound, party)
	}
	return pk, nil
}

// Parties returns the registered party ids in deterministic order. Used by
// the boot self-check and config-prod tests.
func (r *PayerKeyRegistry) Parties() []string {
	if r == nil {
		return nil
	}
	out := make([]string, 0, len(r.keys))
	for k := range r.keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Len returns the number of registered parties.
func (r *PayerKeyRegistry) Len() int {
	if r == nil {
		return 0
	}
	return len(r.keys)
}

// assertNoDuplicateKeys decodes the JSON stream token-by-token and rejects any
// top-level object that repeats the same key. encoding/json silently coalesces
// duplicates by default, which would let an operator typo `"alice"` twice and
// not notice the first entry was overwritten.
func assertNoDuplicateKeys(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("json: %w", err)
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return fmt.Errorf("json: top-level value must be an object")
	}
	seen := make(map[string]struct{})
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return fmt.Errorf("json: %w", err)
		}
		key, ok := k.(string)
		if !ok {
			return fmt.Errorf("json: non-string key %v", k)
		}
		if _, dup := seen[key]; dup {
			return fmt.Errorf("duplicate party id %q", key)
		}
		seen[key] = struct{}{}
		// consume the value
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return fmt.Errorf("json: %w", err)
		}
	}
	return nil
}
