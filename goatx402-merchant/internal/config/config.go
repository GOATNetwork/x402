// Package config loads the merchant demo server configuration from
// environment variables. Defaults match the values cited in PLAN.md §5.3
// and §5.5 so the demo boots cleanly on a developer laptop with no env.
package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultReceiptMaxBytes is the upper bound the merchant accepts on the
	// X-PAYMENT header value before base64-decode (PLAN.md §5.5).
	DefaultReceiptMaxBytes = 8 * 1024

	// DefaultReceiptReplayLRUSize bounds the replay cache (PLAN.md §5.5).
	DefaultReceiptReplayLRUSize = 10_000

	// DefaultNonceLRUSize bounds the issued-nonce cache (PLAN.md §5.5).
	DefaultNonceLRUSize = 10_000

	// NonceLRUSizeMin/Max are the inclusive bounds enforced at boot for
	// MERCHANT_NONCE_LRU_SIZE (PLAN.md §5.5).
	NonceLRUSizeMin = 1024
	NonceLRUSizeMax = 1_000_000

	// DefaultReceiptMaxAge is the freshness window the verifier uses
	// (PLAN.md §5.5).
	DefaultReceiptMaxAge = 5 * time.Minute

	// DefaultReceiptMaxClockSkew tolerates participant clocks running ahead
	// of the merchant (PLAN.md §6.4).
	DefaultReceiptMaxClockSkew = 30 * time.Second

	// DefaultResourceRateLimitRPS is the per-source-IP token-bucket rate
	// applied to /resource (PLAN.md §5.3).
	DefaultResourceRateLimitRPS = 30.0

	// DefaultResourceRateBurst lets short bursts through before the bucket
	// is empty; matches a 1-second window at the default RPS.
	DefaultResourceRateBurst = 30
)

// Config aggregates every knob the merchant needs at boot. Every value is
// passed explicitly so the API/replay packages perform zero env reads.
type Config struct {
	Addr string

	// Resource is the path the merchant gates with x402.
	Resource string

	// Merchant party id mirrored into the 402 envelope and asserted on the
	// returned receipt.
	Merchant string

	// Amount, Currency, TrustedIssuer make up the rest of the expected
	// challenge tuple that the merchant compares against the receipt.
	Amount        string
	Currency      string
	TrustedIssuer string

	FacilitatorURL string

	// ParticipantPubKey is the pinned trust anchor (PLAN.md §6.4).
	ParticipantPubKey ed25519.PublicKey
	AcceptKeys        []ed25519.PublicKey

	ReceiptMaxAge       time.Duration
	ReceiptMaxClockSkew time.Duration

	// ReceiptMaxBytes caps the X-PAYMENT header value length before
	// base64-decode (PLAN.md §5.5).
	ReceiptMaxBytes int

	ReceiptReplayLRUSize int
	NonceLRUSize         int

	ResourceRateLimitRPS float64
	ResourceRateBurst    int

	CORSOrigins []string

	// Body is the protected content served on 200.
	Body []byte
}

// Load reads env into Config, applying defaults. Returns an error if any
// invariant is violated so the operator notices at boot, not at first
// request.
func Load() (Config, error) {
	cfg := Config{
		Addr:                 envOrDefault("MERCHANT_ADDR", ":7070"),
		Resource:             envOrDefault("MERCHANT_RESOURCE_PATH", "/resource"),
		Merchant:             os.Getenv("MERCHANT_PARTY_ID"),
		Amount:               envOrDefault("MERCHANT_AMOUNT", "1.50"),
		Currency:             envOrDefault("MERCHANT_CURRENCY", "USD-canton"),
		TrustedIssuer:        os.Getenv("MERCHANT_TRUSTED_ISSUER"),
		FacilitatorURL:       envOrDefault("MERCHANT_FACILITATOR_URL", "http://localhost:8080"),
		ReceiptMaxAge:        DefaultReceiptMaxAge,
		ReceiptMaxClockSkew:  DefaultReceiptMaxClockSkew,
		ReceiptMaxBytes:      DefaultReceiptMaxBytes,
		ReceiptReplayLRUSize: DefaultReceiptReplayLRUSize,
		NonceLRUSize:         DefaultNonceLRUSize,
		ResourceRateLimitRPS: DefaultResourceRateLimitRPS,
		ResourceRateBurst:    DefaultResourceRateBurst,
		Body:                 []byte(envOrDefault("MERCHANT_RESOURCE_BODY", "x402 unlocked: hello")),
	}

	if raw := os.Getenv("RECEIPT_MAX_BYTES"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: RECEIPT_MAX_BYTES must be a positive integer: %q", raw)
		}
		cfg.ReceiptMaxBytes = n
	}
	if raw := os.Getenv("RECEIPT_REPLAY_LRU_SIZE"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: RECEIPT_REPLAY_LRU_SIZE must be a positive integer: %q", raw)
		}
		cfg.ReceiptReplayLRUSize = n
	}
	if raw := os.Getenv("MERCHANT_NONCE_LRU_SIZE"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("config: MERCHANT_NONCE_LRU_SIZE must be an integer: %q", raw)
		}
		if n < NonceLRUSizeMin || n > NonceLRUSizeMax {
			return Config{}, fmt.Errorf("config: MERCHANT_NONCE_LRU_SIZE=%d out of bounds [%d, %d]", n, NonceLRUSizeMin, NonceLRUSizeMax)
		}
		cfg.NonceLRUSize = n
	}
	if raw := os.Getenv("RECEIPT_MAX_AGE_SECONDS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: RECEIPT_MAX_AGE_SECONDS must be a positive integer: %q", raw)
		}
		cfg.ReceiptMaxAge = time.Duration(n) * time.Second
	}
	if raw := os.Getenv("RECEIPT_MAX_CLOCK_SKEW_SECONDS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return Config{}, fmt.Errorf("config: RECEIPT_MAX_CLOCK_SKEW_SECONDS must be a non-negative integer: %q", raw)
		}
		cfg.ReceiptMaxClockSkew = time.Duration(n) * time.Second
	}
	if raw := os.Getenv("MERCHANT_RESOURCE_RATE_LIMIT"); raw != "" {
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil || f <= 0 {
			return Config{}, fmt.Errorf("config: MERCHANT_RESOURCE_RATE_LIMIT must be a positive number: %q", raw)
		}
		cfg.ResourceRateLimitRPS = f
		// Burst follows RPS by default; explicit override below.
		cfg.ResourceRateBurst = int(f)
		if cfg.ResourceRateBurst < 1 {
			cfg.ResourceRateBurst = 1
		}
	}
	if raw := os.Getenv("MERCHANT_RESOURCE_RATE_BURST"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: MERCHANT_RESOURCE_RATE_BURST must be a positive integer: %q", raw)
		}
		cfg.ResourceRateBurst = n
	}

	if raw := os.Getenv("CORS_ORIGINS"); raw != "" {
		for _, o := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(o); t != "" {
				cfg.CORSOrigins = append(cfg.CORSOrigins, t)
			}
		}
	} else {
		cfg.CORSOrigins = []string{"http://localhost:5173"}
	}

	if path := os.Getenv("PARTICIPANT_PUBKEY_PATH"); path != "" {
		pub, err := loadPubKey(path)
		if err != nil {
			return Config{}, fmt.Errorf("config: PARTICIPANT_PUBKEY_PATH: %w", err)
		}
		cfg.ParticipantPubKey = pub
	}
	if path := os.Getenv("PARTICIPANT_ACCEPT_PUBKEY_PATH"); path != "" {
		pub, err := loadPubKey(path)
		if err != nil {
			return Config{}, fmt.Errorf("config: PARTICIPANT_ACCEPT_PUBKEY_PATH: %w", err)
		}
		cfg.AcceptKeys = []ed25519.PublicKey{pub}
	}

	return cfg, nil
}

// Validate enforces the invariants the merchant relies on at request time.
// It is split out from Load so tests can construct a Config directly and
// still get the same boot-time gates.
func (c Config) Validate() error {
	if c.Resource == "" {
		return errors.New("config: Resource required")
	}
	if c.Merchant == "" {
		return errors.New("config: Merchant required")
	}
	if c.Amount == "" || c.Currency == "" {
		return errors.New("config: Amount and Currency required")
	}
	if c.TrustedIssuer == "" {
		return errors.New("config: TrustedIssuer required")
	}
	if len(c.ParticipantPubKey) != ed25519.PublicKeySize {
		return errors.New("config: ParticipantPubKey must be 32 bytes")
	}
	if c.ReceiptMaxBytes <= 0 {
		return errors.New("config: ReceiptMaxBytes must be positive")
	}
	if c.ReceiptReplayLRUSize <= 0 {
		return errors.New("config: ReceiptReplayLRUSize must be positive")
	}
	if c.NonceLRUSize < NonceLRUSizeMin || c.NonceLRUSize > NonceLRUSizeMax {
		return fmt.Errorf("config: NonceLRUSize=%d out of bounds [%d, %d]", c.NonceLRUSize, NonceLRUSizeMin, NonceLRUSizeMax)
	}
	if c.ReceiptMaxAge <= 0 {
		return errors.New("config: ReceiptMaxAge must be positive")
	}
	if c.ReceiptMaxClockSkew < 0 {
		return errors.New("config: ReceiptMaxClockSkew must be non-negative")
	}
	if c.ResourceRateLimitRPS <= 0 {
		return errors.New("config: ResourceRateLimitRPS must be positive")
	}
	if c.ResourceRateBurst <= 0 {
		return errors.New("config: ResourceRateBurst must be positive")
	}
	if len(c.AcceptKeys) > 1 {
		// Mirrors verify.MaxAcceptKeys = 1.
		return errors.New("config: at most one AcceptKey allowed during rotation")
	}
	return nil
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadPubKey(path string) (ed25519.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(raw))
	dec, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}
	if len(dec) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("expected %d bytes, got %d", ed25519.PublicKeySize, len(dec))
	}
	return ed25519.PublicKey(dec), nil
}
