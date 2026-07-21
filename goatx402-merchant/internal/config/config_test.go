package config_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goatnetwork/goatx402-merchant/internal/config"
)

func TestLoad_DefaultsAreApplied(t *testing.T) {
	clearMerchantEnv(t)
	t.Setenv("MERCHANT_PARTY_ID", "Merchant::abc")
	t.Setenv("MERCHANT_TRUSTED_ISSUER", "Issuer::abc")
	pubPath := writePubKeyFixture(t)
	t.Setenv("PARTICIPANT_PUBKEY_PATH", pubPath)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReceiptMaxBytes != config.DefaultReceiptMaxBytes {
		t.Fatalf("ReceiptMaxBytes: want %d, got %d", config.DefaultReceiptMaxBytes, cfg.ReceiptMaxBytes)
	}
	if cfg.NonceLRUSize != config.DefaultNonceLRUSize {
		t.Fatalf("NonceLRUSize: want %d, got %d", config.DefaultNonceLRUSize, cfg.NonceLRUSize)
	}
	if cfg.Resource != "/resource" {
		t.Fatalf("Resource: want /resource, got %q", cfg.Resource)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

// TestLoad_NonceLRUSizeBoundsEnforced pins PLAN.md §5.5 round-3 Claude P1
// fix: MERCHANT_NONCE_LRU_SIZE must reject outside-bounds values at boot.
func TestLoad_NonceLRUSizeBoundsEnforced(t *testing.T) {
	clearMerchantEnv(t)
	t.Setenv("MERCHANT_PARTY_ID", "Merchant::abc")
	t.Setenv("MERCHANT_TRUSTED_ISSUER", "Issuer::abc")
	t.Setenv("PARTICIPANT_PUBKEY_PATH", writePubKeyFixture(t))

	tooSmall := config.NonceLRUSizeMin - 1
	t.Setenv("MERCHANT_NONCE_LRU_SIZE", itoa(tooSmall))
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "out of bounds") {
		t.Fatalf("expected out-of-bounds rejection, got %v", err)
	}

	tooBig := config.NonceLRUSizeMax + 1
	t.Setenv("MERCHANT_NONCE_LRU_SIZE", itoa(tooBig))
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "out of bounds") {
		t.Fatalf("expected out-of-bounds rejection (high), got %v", err)
	}
}

func TestLoad_OverridesApplied(t *testing.T) {
	clearMerchantEnv(t)
	t.Setenv("MERCHANT_PARTY_ID", "Merchant::abc")
	t.Setenv("MERCHANT_TRUSTED_ISSUER", "Issuer::abc")
	t.Setenv("PARTICIPANT_PUBKEY_PATH", writePubKeyFixture(t))
	t.Setenv("RECEIPT_MAX_BYTES", "4096")
	t.Setenv("MERCHANT_RESOURCE_RATE_LIMIT", "5")
	t.Setenv("CORS_ORIGINS", "http://foo,http://bar")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReceiptMaxBytes != 4096 {
		t.Fatalf("ReceiptMaxBytes: want 4096, got %d", cfg.ReceiptMaxBytes)
	}
	if cfg.ResourceRateLimitRPS != 5 {
		t.Fatalf("ResourceRateLimitRPS: want 5, got %v", cfg.ResourceRateLimitRPS)
	}
	if len(cfg.CORSOrigins) != 2 || cfg.CORSOrigins[0] != "http://foo" {
		t.Fatalf("CORSOrigins: %v", cfg.CORSOrigins)
	}
}

func TestValidate_RejectsMissingMerchant(t *testing.T) {
	cfg := config.Config{}
	if err := cfg.Validate(); err == nil {
		t.Fatalf("expected error on missing fields")
	}
}

// clearMerchantEnv unsets every MERCHANT_* / RECEIPT_* / CORS_* /
// PARTICIPANT_* key so a test can drive Load() deterministically without
// leaking outer-process env. t.Setenv handles restore at test end.
func clearMerchantEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"MERCHANT_ADDR", "MERCHANT_RESOURCE_PATH", "MERCHANT_PARTY_ID",
		"MERCHANT_AMOUNT", "MERCHANT_CURRENCY", "MERCHANT_TRUSTED_ISSUER",
		"MERCHANT_FACILITATOR_URL", "MERCHANT_NONCE_LRU_SIZE",
		"MERCHANT_RESOURCE_RATE_LIMIT", "MERCHANT_RESOURCE_RATE_BURST",
		"MERCHANT_RESOURCE_BODY", "RECEIPT_MAX_BYTES",
		"RECEIPT_REPLAY_LRU_SIZE", "RECEIPT_MAX_AGE_SECONDS",
		"RECEIPT_MAX_CLOCK_SKEW_SECONDS", "CORS_ORIGINS",
		"PARTICIPANT_PUBKEY_PATH", "PARTICIPANT_ACCEPT_PUBKEY_PATH",
	} {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
}

func writePubKeyFixture(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "participant.pub")
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(pub)), 0o600); err != nil {
		t.Fatalf("write pubkey: %v", err)
	}
	return path
}

func itoa(n int) string {
	// strconv.Itoa would do but we keep imports minimal.
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	digits := make([]byte, 0, 8)
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}
