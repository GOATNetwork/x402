// Package config owns every env var the facilitator binary consumes and the
// CANTON_PROD=true boot-time validation matrix from PLAN.md §5.5.
//
// All env reads happen here so handlers, the canton client, and the store stay
// I/O-free. Load returns a populated Config or a wrapped error that names the
// offending env var. Validate enforces the §5.5 matrix when CantonProd is true.
package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidConfig is the sentinel for every boot-time matrix failure. Wraps a
// human-readable reason; CANTON_PROD operators see the failing key in the
// process exit message.
var ErrInvalidConfig = errors.New("config: invalid")

// Config carries every tunable PLAN.md §5.5 enumerates plus the per-package
// knobs §6.2 / §5.5 reference. Defaults match the plan; Load applies them when
// the env var is unset.
type Config struct {
	// CantonProd is the only flag that flips the production matrix on.
	// false (default) = v0 localnet semantics.
	CantonProd bool

	// HTTP listener.
	HTTPAddr string

	// Canton transport.
	ParticipantHost    string
	ParticipantPort    int
	ParticipantUseTLS  bool
	ParticipantUser    string
	ParticipantJWTPath string
	LedgerID           string

	// Custodial / payer-binding files (gitignored).
	CustodialKeyDir       string
	PayerKeyRegistryPath  string
	PayerTokenFile        string
	ParticipantSigningKey string // PARTICIPANT_SIGNING_KEY_PATH
	ParticipantSigningKeyFingerprint string
	ParticipantPubKeyPath string

	// Trusted-issuer + currency allow-list.
	CurrencyAllowList map[string]struct{}
	TrustedIssuerMap  map[string]string // currency -> issuer party id

	// Admin endpoint.
	AdminToken string

	// CORS.
	CORSOrigins []string

	// Rate limit.
	RateLimitPerToken   float64
	RateLimitPerIP      float64
	RateLimitIPMapMax   int
	MaxInflightPay      int
	MaxInflightWait     int

	// Order envelope.
	OrderBodyLimit      int64
	X402SupportedVersions []int

	// Ledger time / completion knobs (mirrored into canton.Config too).
	CompletionTTL                    time.Duration
	RetryWindowMax                   time.Duration
	MaxRetries                       int
	LedgerSkewSafety                 time.Duration
	MaxDeduplicationDuration         time.Duration
	MaxDeduplicationDurationFallback time.Duration

	// Wait policy.
	WaitDefault    time.Duration
	WaitMax        time.Duration
	ShutdownTimeout time.Duration

	// LAPI / gRPC pool timeouts (PLAN.md §6.2 P1).
	LAPIHTTPTimeout           time.Duration
	LAPIMaxIdleConns          int
	LAPIMaxConcurrentRequests int
	GRPCKeepaliveTime         time.Duration
	GRPCKeepaliveTimeout      time.Duration

	// Receipts / freshness for self-verify VerifyOptions.
	ReceiptMaxAge      time.Duration
	ReceiptMaxClockSkew time.Duration

	// Localnet-only: source-holding fixture file consumed by
	// GET /api/v1/dev/source-holding.
	SourceHoldingFixturePath string

	// Receipt domain (defaults to receipt.DomainV1).
	ReceiptDomain string
}

// Load reads every env var the facilitator consumes, applies defaults, and
// returns a Config plus any validation error. Callers MUST call Validate
// before using the result.
func Load(getEnv func(string) string) (Config, error) {
	if getEnv == nil {
		getEnv = os.Getenv
	}
	c := Config{
		HTTPAddr:                         envOr(getEnv, "HTTP_ADDR", ":8080"),
		ParticipantHost:                  envOr(getEnv, "PARTICIPANT_HOST", "localhost"),
		ParticipantUseTLS:                envBool(getEnv, "PARTICIPANT_TLS", false),
		ParticipantUser:                  getEnv("PARTICIPANT_USER"),
		ParticipantJWTPath:               getEnv("PARTICIPANT_JWT_PATH"),
		LedgerID:                         envOr(getEnv, "LEDGER_ID", "participant1"),
		CustodialKeyDir:                  getEnv("CUSTODIAL_KEY_DIR"),
		PayerKeyRegistryPath:             getEnv("PAYER_KEY_REGISTRY_PATH"),
		PayerTokenFile:                   getEnv("PAYER_TOKEN_FILE"),
		ParticipantSigningKey:            getEnv("PARTICIPANT_SIGNING_KEY_PATH"),
		ParticipantSigningKeyFingerprint: getEnv("PARTICIPANT_SIGNING_KEY_FINGERPRINT"),
		ParticipantPubKeyPath:            getEnv("PARTICIPANT_PUBKEY_PATH"),
		AdminToken:                       getEnv("ADMIN_TOKEN"),
		SourceHoldingFixturePath:         getEnv("SOURCE_HOLDING_FIXTURE_PATH"),
		ReceiptDomain:                    envOr(getEnv, "RECEIPT_DOMAIN", "goat-canton-receipt:v1"),
	}

	c.CantonProd = envBool(getEnv, "CANTON_PROD", false)

	port, err := envInt(getEnv, "PARTICIPANT_PORT", 5011)
	if err != nil {
		return c, err
	}
	c.ParticipantPort = port

	c.CORSOrigins = splitCSV(envOr(getEnv, "CORS_ORIGINS", "http://localhost:5173"))

	allow := splitCSV(envOr(getEnv, "CURRENCY_ALLOWLIST", "USD-canton"))
	c.CurrencyAllowList = make(map[string]struct{}, len(allow))
	for _, a := range allow {
		c.CurrencyAllowList[a] = struct{}{}
	}

	issuerJSON := getEnv("TRUSTED_ISSUER_MAP")
	c.TrustedIssuerMap = map[string]string{}
	if issuerJSON != "" {
		if err := json.Unmarshal([]byte(issuerJSON), &c.TrustedIssuerMap); err != nil {
			return c, fmt.Errorf("%w: TRUSTED_ISSUER_MAP: %v", ErrInvalidConfig, err)
		}
	}

	if c.RateLimitPerToken, err = envFloat(getEnv, "RATE_LIMIT_PER_TOKEN_RPS", 10); err != nil {
		return c, err
	}
	if c.RateLimitPerIP, err = envFloat(getEnv, "RATE_LIMIT_PER_IP_RPS", 100); err != nil {
		return c, err
	}
	if c.RateLimitIPMapMax, err = envInt(getEnv, "RATE_LIMIT_IP_MAP_MAX", 100_000); err != nil {
		return c, err
	}
	if c.MaxInflightPay, err = envInt(getEnv, "MAX_INFLIGHT_PAY", 256); err != nil {
		return c, err
	}
	if c.MaxInflightWait, err = envInt(getEnv, "MAX_INFLIGHT_WAIT", 256); err != nil {
		return c, err
	}

	if size, err := envInt(getEnv, "ORDER_BODY_LIMIT", 32*1024); err == nil {
		c.OrderBodyLimit = int64(size)
	} else {
		return c, err
	}

	versCSV := envOr(getEnv, "X402_SUPPORTED_VERSIONS", "1")
	for _, v := range splitCSV(versCSV) {
		n, perr := strconv.Atoi(v)
		if perr != nil {
			return c, fmt.Errorf("%w: X402_SUPPORTED_VERSIONS=%q: %v", ErrInvalidConfig, versCSV, perr)
		}
		c.X402SupportedVersions = append(c.X402SupportedVersions, n)
	}

	if c.CompletionTTL, err = envDuration(getEnv, "COMPLETION_TTL", 10*time.Minute); err != nil {
		return c, err
	}
	if c.RetryWindowMax, err = envDuration(getEnv, "RETRY_WINDOW_MAX", 60*time.Second); err != nil {
		return c, err
	}
	if c.MaxRetries, err = envInt(getEnv, "MAX_RETRIES", 3); err != nil {
		return c, err
	}
	if c.LedgerSkewSafety, err = envDuration(getEnv, "LEDGER_SKEW_SAFETY", 30*time.Second); err != nil {
		return c, err
	}
	if c.MaxDeduplicationDuration, err = envDuration(getEnv, "MAX_DEDUPLICATION_DURATION", 0); err != nil {
		return c, err
	}
	if c.MaxDeduplicationDurationFallback, err = envDuration(getEnv, "MAX_DEDUPLICATION_DURATION_FALLBACK", 24*time.Hour); err != nil {
		return c, err
	}
	if c.WaitDefault, err = envDuration(getEnv, "WAIT_DEFAULT", 5*time.Second); err != nil {
		return c, err
	}
	if c.WaitMax, err = envDuration(getEnv, "WAIT_MAX", 30*time.Second); err != nil {
		return c, err
	}
	if c.ShutdownTimeout, err = envDuration(getEnv, "SHUTDOWN_TIMEOUT", 30*time.Second); err != nil {
		return c, err
	}
	if c.LAPIHTTPTimeout, err = envDuration(getEnv, "LAPI_HTTP_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.LAPIMaxIdleConns, err = envInt(getEnv, "LAPI_MAX_IDLE_CONNS", 32); err != nil {
		return c, err
	}
	if c.LAPIMaxConcurrentRequests, err = envInt(getEnv, "LAPI_MAX_CONCURRENT_REQUESTS", 256); err != nil {
		return c, err
	}
	if c.GRPCKeepaliveTime, err = envDuration(getEnv, "GRPC_KEEPALIVE_TIME", 30*time.Second); err != nil {
		return c, err
	}
	if c.GRPCKeepaliveTimeout, err = envDuration(getEnv, "GRPC_KEEPALIVE_TIMEOUT", 10*time.Second); err != nil {
		return c, err
	}
	if c.ReceiptMaxAge, err = envDuration(getEnv, "RECEIPT_MAX_AGE", 5*time.Minute); err != nil {
		return c, err
	}
	if c.ReceiptMaxClockSkew, err = envDuration(getEnv, "RECEIPT_MAX_CLOCK_SKEW", 30*time.Second); err != nil {
		return c, err
	}
	return c, nil
}

// localnetParticipantHosts is the closed set of hostnames §5.5 calls localnet.
// CANTON_PROD=true must NOT point ParticipantHost at any of these.
var localnetParticipantHosts = map[string]struct{}{
	"localhost":    {},
	"127.0.0.1":    {},
	"::1":          {},
	"canton.local": {},
}

// Validate runs the full §5.5 matrix when CantonProd is true. It is also
// called from Load by callers who don't yet need the file-side checks; tests
// invoke Validate directly to enumerate the matrix.
func (c Config) Validate() error {
	// Universal invariants (apply in both dev and prod).
	if c.HTTPAddr == "" {
		return fmt.Errorf("%w: HTTP_ADDR is empty", ErrInvalidConfig)
	}
	if c.CompletionTTL <= 0 {
		return fmt.Errorf("%w: COMPLETION_TTL must be > 0", ErrInvalidConfig)
	}
	if c.RetryWindowMax <= 0 || c.RetryWindowMax >= c.CompletionTTL {
		return fmt.Errorf("%w: RETRY_WINDOW_MAX must be > 0 and < COMPLETION_TTL", ErrInvalidConfig)
	}
	effectiveMaxDedup := c.MaxDeduplicationDuration
	if effectiveMaxDedup <= 0 {
		effectiveMaxDedup = c.MaxDeduplicationDurationFallback
	}
	if effectiveMaxDedup <= 0 {
		return fmt.Errorf("%w: MAX_DEDUPLICATION_DURATION_FALLBACK must be > 0", ErrInvalidConfig)
	}
	if c.CompletionTTL > effectiveMaxDedup {
		return fmt.Errorf("%w: COMPLETION_TTL (%s) > maxDeduplicationDuration (%s)", ErrInvalidConfig, c.CompletionTTL, effectiveMaxDedup)
	}
	if c.RateLimitIPMapMax <= 0 {
		return fmt.Errorf("%w: RATE_LIMIT_IP_MAP_MAX must be > 0", ErrInvalidConfig)
	}
	if c.OrderBodyLimit <= 0 {
		return fmt.Errorf("%w: ORDER_BODY_LIMIT must be > 0", ErrInvalidConfig)
	}
	if len(c.CurrencyAllowList) == 0 {
		return fmt.Errorf("%w: CURRENCY_ALLOWLIST is empty", ErrInvalidConfig)
	}

	// Token bindings are mandatory in every mode (§5.5 P1 fix).
	if c.PayerTokenFile == "" {
		return fmt.Errorf("%w: PAYER_TOKEN_FILE is required", ErrInvalidConfig)
	}
	if err := assertFileNonEmpty(c.PayerTokenFile, "PAYER_TOKEN_FILE"); err != nil {
		return err
	}
	if c.PayerKeyRegistryPath == "" {
		return fmt.Errorf("%w: PAYER_KEY_REGISTRY_PATH is required", ErrInvalidConfig)
	}
	if err := assertFileNonEmpty(c.PayerKeyRegistryPath, "PAYER_KEY_REGISTRY_PATH"); err != nil {
		return err
	}

	// Trusted-issuer map must cover every currency in the allow-list.
	for ccy := range c.CurrencyAllowList {
		if c.TrustedIssuerMap[ccy] == "" {
			return fmt.Errorf("%w: TRUSTED_ISSUER_MAP missing currency %q", ErrInvalidConfig, ccy)
		}
	}

	// Production-only matrix.
	if c.CantonProd {
		if _, isLocal := localnetParticipantHosts[c.ParticipantHost]; isLocal {
			return fmt.Errorf("%w: CANTON_PROD=true forbids PARTICIPANT_HOST=%q", ErrInvalidConfig, c.ParticipantHost)
		}
		if !c.ParticipantUseTLS {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_TLS=true", ErrInvalidConfig)
		}
		if c.CustodialKeyDir != "" {
			return fmt.Errorf("%w: CANTON_PROD=true forbids CUSTODIAL_KEY_DIR (F10 retires /custodial-sign)", ErrInvalidConfig)
		}
		if c.ParticipantUser == "" {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_USER", ErrInvalidConfig)
		}
		if c.ParticipantJWTPath == "" {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_JWT_PATH", ErrInvalidConfig)
		}
		if err := assertFileNonEmpty(c.ParticipantJWTPath, "PARTICIPANT_JWT_PATH"); err != nil {
			return err
		}
		if err := assertFileMode600(c.ParticipantJWTPath, "PARTICIPANT_JWT_PATH"); err != nil {
			return err
		}
		if err := assertFileMode600(c.PayerTokenFile, "PAYER_TOKEN_FILE"); err != nil {
			return err
		}
		if c.ParticipantSigningKey == "" {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_SIGNING_KEY_PATH", ErrInvalidConfig)
		}
		if !isHSMHandle(c.ParticipantSigningKey) {
			return fmt.Errorf("%w: CANTON_PROD=true requires HSM-backed PARTICIPANT_SIGNING_KEY_PATH (pkcs11: or KMS_*); got %q",
				ErrInvalidConfig, c.ParticipantSigningKey)
		}
		if c.ParticipantSigningKeyFingerprint == "" {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_SIGNING_KEY_FINGERPRINT", ErrInvalidConfig)
		}
		if c.ParticipantPubKeyPath == "" {
			return fmt.Errorf("%w: CANTON_PROD=true requires PARTICIPANT_PUBKEY_PATH", ErrInvalidConfig)
		}
		if err := assertFileNonEmpty(c.ParticipantPubKeyPath, "PARTICIPANT_PUBKEY_PATH"); err != nil {
			return err
		}
		if c.AdminToken == "" || len(c.AdminToken) < 32 {
			return fmt.Errorf("%w: CANTON_PROD=true requires ADMIN_TOKEN of >= 32 bytes", ErrInvalidConfig)
		}
		for _, origin := range c.CORSOrigins {
			if origin == "*" {
				return fmt.Errorf("%w: CANTON_PROD=true forbids CORS_ORIGINS=*", ErrInvalidConfig)
			}
			if u, perr := url.Parse(origin); perr == nil {
				if strings.EqualFold(u.Hostname(), "localhost") {
					return fmt.Errorf("%w: CANTON_PROD=true forbids CORS_ORIGINS localhost (%s)", ErrInvalidConfig, origin)
				}
			}
		}
	}
	return nil
}

// isHSMHandle reports whether path is plausibly an HSM/KMS handle. The
// boot check rejects plain on-disk private-key files. PLAN.md §5.5: prefix is
// pkcs11: or KMS_*.
func isHSMHandle(path string) bool {
	if strings.HasPrefix(path, "pkcs11:") {
		return true
	}
	if strings.HasPrefix(path, "KMS_") {
		return true
	}
	return false
}

// LoadPayerTokens parses PAYER_TOKEN_FILE: a JSON object mapping partyId →
// base64(raw 32-byte token). PLAN.md §5.5 format. Duplicate keys are rejected
// by a token-by-token decode.
func LoadPayerTokens(path string) (map[string][]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("%w: PAYER_TOKEN_FILE is empty", ErrInvalidConfig)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("payer token file: %w", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, fmt.Errorf("%w: PAYER_TOKEN_FILE is empty", ErrInvalidConfig)
	}
	if err := assertJSONNoDuplicateKeys(data); err != nil {
		return nil, fmt.Errorf("payer token file: %w", err)
	}
	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("payer token file: parse: %w", err)
	}
	out := make(map[string][]byte, len(raw))
	for party, b64 := range raw {
		if party == "" {
			return nil, fmt.Errorf("payer token file: empty party id")
		}
		tok, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("payer token file: party %s: base64: %w", party, err)
		}
		if len(tok) == 0 {
			return nil, fmt.Errorf("payer token file: party %s: empty token", party)
		}
		out[party] = tok
	}
	return out, nil
}

// LoadParticipantPubKey decodes PARTICIPANT_PUBKEY_PATH as base64(raw 32-byte
// Ed25519 public key). Used by Task 9's self-verify wiring.
func LoadParticipantPubKey(path string) (ed25519.PublicKey, error) {
	if path == "" {
		return nil, fmt.Errorf("%w: PARTICIPANT_PUBKEY_PATH is empty", ErrInvalidConfig)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("participant pubkey: %w", err)
	}
	s := strings.TrimSpace(string(data))
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("participant pubkey: base64: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("participant pubkey: wrong size %d", len(raw))
	}
	pk := make(ed25519.PublicKey, ed25519.PublicKeySize)
	copy(pk, raw)
	return pk, nil
}

// LoadParticipantSigningKey decodes a non-HSM v0 private key file
// (base64-encoded raw 64-byte Ed25519 private key). HSM-backed handles
// (pkcs11:, KMS_) MUST be loaded by the operator-provided HSM bridge — this
// helper deliberately returns an error so a plain file cannot impersonate an
// HSM-backed handle in production. CANTON_PROD=true is rejected at Validate.
func LoadParticipantSigningKey(path string) (ed25519.PrivateKey, error) {
	if path == "" {
		return nil, fmt.Errorf("%w: PARTICIPANT_SIGNING_KEY_PATH is empty", ErrInvalidConfig)
	}
	if isHSMHandle(path) {
		return nil, fmt.Errorf("participant signing key: HSM handle %q must be loaded via an HSM bridge, not this helper", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("participant signing key: %w", err)
	}
	s := strings.TrimSpace(string(data))
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("participant signing key: base64: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("participant signing key: wrong size %d", len(raw))
	}
	priv := make(ed25519.PrivateKey, ed25519.PrivateKeySize)
	copy(priv, raw)
	return priv, nil
}

// ---- env helpers --------------------------------------------------------

func envOr(get func(string) string, key, def string) string {
	if v := get(key); v != "" {
		return v
	}
	return def
}

func envBool(get func(string) string, key string, def bool) bool {
	v := get(key)
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envInt(get func(string) string, key string, def int) (int, error) {
	v := get(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%w: %s=%q: %v", ErrInvalidConfig, key, v, err)
	}
	return n, nil
}

func envFloat(get func(string) string, key string, def float64) (float64, error) {
	v := get(key)
	if v == "" {
		return def, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: %s=%q: %v", ErrInvalidConfig, key, v, err)
	}
	return f, nil
}

func envDuration(get func(string) string, key string, def time.Duration) (time.Duration, error) {
	v := get(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%w: %s=%q: %v", ErrInvalidConfig, key, v, err)
	}
	return d, nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func assertFileNonEmpty(path, label string) error {
	if path == "" {
		return fmt.Errorf("%w: %s is empty", ErrInvalidConfig, label)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%w: %s (%s): %v", ErrInvalidConfig, label, path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%w: %s (%s) is a directory", ErrInvalidConfig, label, path)
	}
	if info.Size() == 0 {
		return fmt.Errorf("%w: %s (%s) is empty", ErrInvalidConfig, label, path)
	}
	return nil
}

func assertFileMode600(path, label string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%w: %s (%s): %v", ErrInvalidConfig, label, path, err)
	}
	mode := info.Mode().Perm()
	// 0600 is the only acceptable mode for secret files in prod.
	if mode != 0o600 {
		return fmt.Errorf("%w: %s (%s) must be chmod 0600 (got %o)", ErrInvalidConfig, label, filepath.Base(path), mode)
	}
	return nil
}

// assertJSONNoDuplicateKeys rejects a top-level object that repeats a key.
// encoding/json silently coalesces duplicates by default; the operator who
// typos a partyId twice should see a hard failure.
func assertJSONNoDuplicateKeys(data []byte) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := tok.(json.Delim)
	if !ok || d != '{' {
		return fmt.Errorf("expected top-level object")
	}
	seen := map[string]struct{}{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		k, ok := t.(string)
		if !ok {
			return fmt.Errorf("non-string key")
		}
		if _, dup := seen[k]; dup {
			return fmt.Errorf("duplicate key %q", k)
		}
		seen[k] = struct{}{}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return err
		}
	}
	return nil
}
