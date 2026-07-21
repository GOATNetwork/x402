package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goatnetwork/goatx402-facilitator/internal/config"
)

// matrixBaseProd returns a Config that satisfies every CANTON_PROD=true row.
// Tests then flip one row at a time and assert Validate fails with a wrapped
// ErrInvalidConfig.
func matrixBaseProd(t *testing.T) (cfg config.Config, cleanup func()) {
	t.Helper()
	dir := t.TempDir()
	payerTok := filepath.Join(dir, "payer-tokens.json")
	if err := os.WriteFile(payerTok, []byte(`{"alice":"YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU="}`), 0o600); err != nil {
		t.Fatalf("write payer-tokens: %v", err)
	}
	payerReg := filepath.Join(dir, "payer-registry.json")
	if err := os.WriteFile(payerReg, []byte(`{"alice":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`), 0o644); err != nil {
		t.Fatalf("write payer-registry: %v", err)
	}
	jwt := filepath.Join(dir, "jwt")
	if err := os.WriteFile(jwt, []byte("dummy"), 0o600); err != nil {
		t.Fatalf("write jwt: %v", err)
	}
	pubKey := filepath.Join(dir, "participant.pub")
	if err := os.WriteFile(pubKey, []byte("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), 0o644); err != nil {
		t.Fatalf("write pubkey: %v", err)
	}

	c := config.Config{
		CantonProd:                       true,
		HTTPAddr:                         ":8080",
		ParticipantHost:                  "canton.example.com",
		ParticipantPort:                  5011,
		ParticipantUseTLS:                true,
		ParticipantUser:                  "facilitator",
		ParticipantJWTPath:               jwt,
		LedgerID:                         "participant1",
		PayerKeyRegistryPath:             payerReg,
		PayerTokenFile:                   payerTok,
		ParticipantSigningKey:            "pkcs11:slot=0;label=participant-key",
		ParticipantSigningKeyFingerprint: "abcd",
		ParticipantPubKeyPath:            pubKey,
		AdminToken:                       strings.Repeat("a", 32),
		CORSOrigins:                      []string{"https://merchant.example.com"},
		CurrencyAllowList:                map[string]struct{}{"USD-canton": {}},
		TrustedIssuerMap:                 map[string]string{"USD-canton": "issuer-party"},
		RateLimitPerToken:                10,
		RateLimitPerIP:                   100,
		RateLimitIPMapMax:                100,
		MaxInflightPay:                   256,
		MaxInflightWait:                  256,
		OrderBodyLimit:                   32 * 1024,
		CompletionTTL:                    10 * 60 * 1_000_000_000, // 10 minutes
		RetryWindowMax:                   60 * 1_000_000_000,      // 60 seconds
		MaxRetries:                       3,
		LedgerSkewSafety:                 30 * 1_000_000_000,
		MaxDeduplicationDurationFallback: 24 * 60 * 60 * 1_000_000_000,
		WaitDefault:                      5 * 1_000_000_000,
		WaitMax:                          30 * 1_000_000_000,
		LAPIHTTPTimeout:                  5 * 1_000_000_000,
		LAPIMaxIdleConns:                 32,
		LAPIMaxConcurrentRequests:        256,
		GRPCKeepaliveTime:                30 * 1_000_000_000,
		GRPCKeepaliveTimeout:             10 * 1_000_000_000,
		ReceiptMaxAge:                    5 * 60 * 1_000_000_000,
		ReceiptMaxClockSkew:              30 * 1_000_000_000,
	}
	cleanup = func() {}
	return c, cleanup
}

func TestValidateProd_HappyPath(t *testing.T) {
	cfg, cleanup := matrixBaseProd(t)
	defer cleanup()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected happy path to validate, got %v", err)
	}
}

// matrixRow is one row of the §5.5 matrix: a mutation against the base config
// plus the expected substring of the failure message.
type matrixRow struct {
	name    string
	mutate  func(c *config.Config)
	wantSub string
}

func TestValidateProd_MatrixRowsFail(t *testing.T) {
	rows := []matrixRow{
		{
			name:    "PARTICIPANT_HOST localhost is forbidden",
			mutate:  func(c *config.Config) { c.ParticipantHost = "localhost" },
			wantSub: "PARTICIPANT_HOST",
		},
		{
			name:    "PARTICIPANT_TLS=false is rejected",
			mutate:  func(c *config.Config) { c.ParticipantUseTLS = false },
			wantSub: "PARTICIPANT_TLS",
		},
		{
			name:    "CUSTODIAL_KEY_DIR must be empty in prod",
			mutate:  func(c *config.Config) { c.CustodialKeyDir = "/tmp/k" },
			wantSub: "CUSTODIAL_KEY_DIR",
		},
		{
			name:    "PARTICIPANT_USER required",
			mutate:  func(c *config.Config) { c.ParticipantUser = "" },
			wantSub: "PARTICIPANT_USER",
		},
		{
			name:    "PARTICIPANT_JWT_PATH required",
			mutate:  func(c *config.Config) { c.ParticipantJWTPath = "" },
			wantSub: "PARTICIPANT_JWT_PATH",
		},
		{
			name:    "PARTICIPANT_SIGNING_KEY_PATH must be HSM-backed",
			mutate:  func(c *config.Config) { c.ParticipantSigningKey = "/tmp/plain.key" },
			wantSub: "HSM-backed",
		},
		{
			name:    "PARTICIPANT_SIGNING_KEY_FINGERPRINT required",
			mutate:  func(c *config.Config) { c.ParticipantSigningKeyFingerprint = "" },
			wantSub: "PARTICIPANT_SIGNING_KEY_FINGERPRINT",
		},
		{
			name:    "PARTICIPANT_PUBKEY_PATH required",
			mutate:  func(c *config.Config) { c.ParticipantPubKeyPath = "" },
			wantSub: "PARTICIPANT_PUBKEY_PATH",
		},
		{
			name:    "PAYER_KEY_REGISTRY_PATH required",
			mutate:  func(c *config.Config) { c.PayerKeyRegistryPath = "" },
			wantSub: "PAYER_KEY_REGISTRY_PATH",
		},
		{
			name:    "PAYER_TOKEN_FILE required",
			mutate:  func(c *config.Config) { c.PayerTokenFile = "" },
			wantSub: "PAYER_TOKEN_FILE",
		},
		{
			name:    "TRUSTED_ISSUER_MAP missing currency",
			mutate:  func(c *config.Config) { c.TrustedIssuerMap = map[string]string{} },
			wantSub: "TRUSTED_ISSUER_MAP",
		},
		{
			name:    "COMPLETION_TTL must be <= maxDeduplicationDuration",
			mutate:  func(c *config.Config) { c.MaxDeduplicationDurationFallback = 5 * 60 * 1_000_000_000 },
			wantSub: "maxDeduplicationDuration",
		},
		{
			name:    "ADMIN_TOKEN >= 32 bytes",
			mutate:  func(c *config.Config) { c.AdminToken = "short" },
			wantSub: "ADMIN_TOKEN",
		},
		{
			name:    "CORS_ORIGINS forbids *",
			mutate:  func(c *config.Config) { c.CORSOrigins = []string{"*"} },
			wantSub: "CORS_ORIGINS",
		},
		{
			name:    "CORS_ORIGINS forbids localhost",
			mutate:  func(c *config.Config) { c.CORSOrigins = []string{"http://localhost:5173"} },
			wantSub: "localhost",
		},
	}

	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			cfg, cleanup := matrixBaseProd(t)
			defer cleanup()
			row.mutate(&cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatalf("expected matrix row to fail, but Validate returned nil")
			}
			if !errors.Is(err, config.ErrInvalidConfig) {
				t.Fatalf("expected ErrInvalidConfig, got %v", err)
			}
			if !strings.Contains(err.Error(), row.wantSub) {
				t.Fatalf("error %q does not contain %q", err.Error(), row.wantSub)
			}
		})
	}
}

func TestValidate_FailsOnZeroCompletionTTL(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:                         ":8080",
		CompletionTTL:                    0,
		RetryWindowMax:                   1,
		MaxDeduplicationDurationFallback: 24 * 60 * 60 * 1_000_000_000,
	}
	err := cfg.Validate()
	if err == nil || !errors.Is(err, config.ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig on CompletionTTL=0, got %v", err)
	}
}

func TestLoadPayerTokens_RejectsDuplicateKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tok.json")
	if err := os.WriteFile(path, []byte(`{"alice":"YWFh","alice":"YmJi"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := config.LoadPayerTokens(path); err == nil {
		t.Fatalf("expected duplicate-key rejection")
	} else if !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("expected duplicate error, got %v", err)
	}
}

func TestLoadPayerTokens_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tok.json")
	if err := os.WriteFile(path, []byte(`{"alice":"YWFh","bob":"YmJi"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	tokens, err := config.LoadPayerTokens(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if string(tokens["alice"]) != "aaa" {
		t.Fatalf("alice token: %q", tokens["alice"])
	}
	if string(tokens["bob"]) != "bbb" {
		t.Fatalf("bob token: %q", tokens["bob"])
	}
}

func TestLoad_DefaultsPopulated(t *testing.T) {
	get := func(string) string { return "" }
	cfg, err := config.Load(get)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr default %q", cfg.HTTPAddr)
	}
	if cfg.OrderBodyLimit != 32*1024 {
		t.Fatalf("ORDER_BODY_LIMIT default %d", cfg.OrderBodyLimit)
	}
	if _, ok := cfg.CurrencyAllowList["USD-canton"]; !ok {
		t.Fatalf("currency allowlist default missing USD-canton: %v", cfg.CurrencyAllowList)
	}
	if cfg.CompletionTTL <= 0 {
		t.Fatalf("CompletionTTL default %v", cfg.CompletionTTL)
	}
}

func TestLoad_InvalidIntFails(t *testing.T) {
	get := func(k string) string {
		if k == "PARTICIPANT_PORT" {
			return "notanumber"
		}
		return ""
	}
	if _, err := config.Load(get); err == nil {
		t.Fatalf("expected Load failure on PARTICIPANT_PORT=notanumber")
	}
}
