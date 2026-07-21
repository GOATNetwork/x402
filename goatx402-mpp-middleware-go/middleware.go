package mppmiddleware

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

// HeaderName is the canonical HTTP header carrying the encoded
// Payment-Receipt produced by EncodeHeader in receiptspec.
const HeaderName = "Payment-Receipt"

// Config bundles everything the middleware needs to verify a
// Payment-Receipt header. A Config value is consumed once by
// Middleware; mutating it afterwards has no effect.
//
// Required fields depend on Algorithm:
//
//   - AlgEd25519: Ed25519Public must be a 32-byte ed25519 public key.
//   - AlgHMACSHA256: HMACSecret must be non-empty (>=32 bytes
//     recommended).
//
// MerchantID and RouteCanonical are always required.
type Config struct {
	// MerchantID is the audience this middleware enforces. The
	// receipt's merchant_id field MUST equal MerchantID or the request
	// is rejected with 401 audience_mismatch.
	MerchantID string

	// RouteCanonical is the canonical identifier of the protected
	// resource (for example "GET:/api/data"). The middleware checks
	// the receipt's request_canonical field either equals
	// RouteCanonical exactly or has it as a "<route>:..." prefix.
	// Using a colon as the separator means a receipt for
	// "GET:/api/data" does NOT match a route of "GET:/api" because
	// "GET:/api/data" does not start with "GET:/api:".
	RouteCanonical string

	// Algorithm tells the middleware which signature scheme to expect
	// in the header's algorithm tail. Receipts arriving with a
	// different algorithm tail are rejected with 401 invalid_signature
	// — algorithm confusion is treated as a security failure, not a
	// negotiation surface.
	Algorithm receiptspec.Algorithm

	// Ed25519Public is the platform's published verification key.
	// Required when Algorithm == receiptspec.AlgEd25519.
	Ed25519Public ed25519.PublicKey

	// HMACSecret is the per-merchant shared secret. Required when
	// Algorithm == receiptspec.AlgHMACSHA256.
	HMACSecret []byte

	// Clock is an optional time source; defaults to time.Now. Tests
	// inject a fixed clock to make expiry checks deterministic.
	Clock func() time.Time

	// OnReject, if non-nil, is invoked with the rejection reason BEFORE
	// the 401/402 response is written. Useful for metrics counters,
	// structured logging, and audit trails. OnReject MUST NOT write to
	// w or modify r in a way that affects subsequent handler chains.
	OnReject func(r *http.Request, reason string)

	// ReceiptIDStore is the optional double-spend defense surface. When
	// non-nil the middleware atomically marks each accepted
	// receipt_id; a second presentation returns 401
	// receipt_already_consumed. Production deployments SHOULD use a
	// distributed store (Redis SET NX with TTL, or a database with a
	// unique constraint) so that scale-out replicas share the
	// consumed-set. See ReceiptIDStore for the contract.
	ReceiptIDStore ReceiptIDStore
}

// ReceiptIDStore is the contract for the optional double-spend defense.
//
// Implementations MUST be safe for concurrent use by multiple goroutines
// and SHOULD be atomic across replicas (otherwise replay between
// replicas is possible). A Redis-backed implementation using
// `SET key NX EX <ttl>` satisfies both requirements with a single
// round-trip. An in-memory sync.Map satisfies the goroutine-safety
// requirement but NOT the cross-replica requirement; it is appropriate
// for single-binary deployments only.
type ReceiptIDStore interface {
	// MarkConsumed atomically records receiptID as consumed with TTL.
	//
	// Returns (true, nil) when this caller is the first to record the
	// receipt_id (the receipt is now considered "consumed" and the
	// middleware will admit the request).
	//
	// Returns (false, nil) when receiptID was already recorded by a
	// previous caller (replay attempt — the middleware will reject the
	// request with 401 receipt_already_consumed).
	//
	// Returns (_, err) on backend failure. The middleware will respond
	// with 503 in that case to make it operationally distinguishable
	// from a legitimate replay rejection.
	//
	// TTL should generally match the receipt's lifetime (issued_at to
	// expires_at). Records that outlive the receipt's expiry are
	// harmless but waste storage; records that expire too early
	// re-enable replays.
	MarkConsumed(ctx context.Context, receiptID string, ttl time.Duration) (consumed bool, err error)
}

// Rejection reason constants — the value written into the "error" field
// of the Problem Details body. They are part of the public API surface
// so callers may key alerting / metrics off them. Adding a new value is
// a non-breaking change; renaming an existing value is a breaking
// change.
const (
	ReasonPaymentRequired         = "payment_required"
	ReasonInvalidPaymentReceipt   = "invalid_payment_receipt"
	ReasonInvalidSignature        = "invalid_signature"
	ReasonAudienceMismatch        = "audience_mismatch"
	ReasonRouteMismatch           = "route_mismatch"
	ReasonReceiptExpired          = "receipt_expired"
	ReasonReceiptAlreadyConsumed  = "receipt_already_consumed"
	ReasonReceiptStoreUnavailable = "receipt_store_unavailable"
)

// receiptCtxKey is an unexported key type so external packages cannot
// collide with us in the request context.
type receiptCtxKey struct{}

// FromContext returns the verified Receipt previously stored by
// Middleware. It returns (zero, false) if no receipt was attached —
// either because the caller invoked the handler outside the middleware
// chain or because the middleware rejected the request (in which case
// the downstream handler never runs at all).
func FromContext(ctx context.Context) (receiptspec.Receipt, bool) {
	r, ok := ctx.Value(receiptCtxKey{}).(receiptspec.Receipt)
	return r, ok
}

// withReceipt returns a copy of ctx that carries r, retrievable via
// FromContext.
func withReceipt(ctx context.Context, r receiptspec.Receipt) context.Context {
	return context.WithValue(ctx, receiptCtxKey{}, r)
}

// configError is returned by validateConfig when Config is structurally
// invalid. Middleware panics with this so misconfiguration is caught at
// composition time rather than producing silent runtime rejections.
type configError struct{ msg string }

func (e *configError) Error() string { return "mppmiddleware: " + e.msg }

// validateConfig enforces the field invariants documented on Config.
// It returns nil on success.
func validateConfig(cfg Config) error {
	if cfg.MerchantID == "" {
		return &configError{msg: "Config.MerchantID is required"}
	}
	if cfg.RouteCanonical == "" {
		return &configError{msg: "Config.RouteCanonical is required"}
	}
	switch cfg.Algorithm {
	case receiptspec.AlgEd25519:
		if len(cfg.Ed25519Public) != ed25519.PublicKeySize {
			return &configError{msg: "Config.Ed25519Public must be a 32-byte ed25519 public key when Algorithm is ed25519"}
		}
	case receiptspec.AlgHMACSHA256:
		if len(cfg.HMACSecret) == 0 {
			return &configError{msg: "Config.HMACSecret must be non-empty when Algorithm is hmac-sha256"}
		}
	default:
		return &configError{msg: "Config.Algorithm must be a registered receiptspec.Algorithm (ed25519 or hmac-sha256)"}
	}
	return nil
}

// Middleware returns an http middleware that verifies the
// Payment-Receipt header on every incoming request. The middleware
// short-circuits with a Problem Details JSON body on any failure and
// invokes next only on success.
//
// Middleware panics if cfg is invalid (missing required field, wrong
// key length, unknown algorithm). This is intentional: misconfiguration
// is a programmer error and should surface at composition time, not as
// a silent stream of 401s in production.
func Middleware(cfg Config) func(next http.Handler) http.Handler {
	if err := validateConfig(cfg); err != nil {
		panic(err)
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			now := clock()
			values := r.Header.Values(HeaderName)
			if len(values) > 1 {
				if cfg.OnReject != nil {
					cfg.OnReject(r, ReasonInvalidPaymentReceipt)
				}
				writeProblem(w, http.StatusUnauthorized, ReasonInvalidPaymentReceipt)
				return
			}
			header := ""
			if len(values) == 1 {
				header = values[0]
			}
			res := verify(cfg, header, now)
			if res.Status != 0 {
				if cfg.OnReject != nil {
					cfg.OnReject(r, res.Reason)
				}
				writeProblem(w, res.Status, res.Reason)
				return
			}

			// Optional double-spend defense. The store is consulted
			// AFTER cryptographic verification so callers cannot use
			// unauthenticated payloads to pollute the store.
			if cfg.ReceiptIDStore != nil {
				ttl := res.Receipt.ReceiptExpiresAt.Sub(now)
				if ttl < 0 {
					// Should be unreachable — verify() already
					// rejected expired receipts — but be defensive.
					ttl = 0
				}
				consumed, err := cfg.ReceiptIDStore.MarkConsumed(r.Context(), res.Receipt.ReceiptID, ttl)
				if err != nil {
					if cfg.OnReject != nil {
						cfg.OnReject(r, ReasonReceiptStoreUnavailable)
					}
					writeProblem(w, http.StatusServiceUnavailable, ReasonReceiptStoreUnavailable)
					return
				}
				if !consumed {
					if cfg.OnReject != nil {
						cfg.OnReject(r, ReasonReceiptAlreadyConsumed)
					}
					writeProblem(w, http.StatusUnauthorized, ReasonReceiptAlreadyConsumed)
					return
				}
			}

			next.ServeHTTP(w, r.WithContext(withReceipt(r.Context(), res.Receipt)))
		})
	}
}

// problemDetails is a minimal RFC 7807 style body. The schema is
// intentionally small: callers should key off Error (machine code) not
// Detail (human string).
type problemDetails struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Error  string `json:"error"`
}

// writeProblem writes a Problem Details JSON response. It deliberately
// does NOT include err.Error() text or any receipt field — the goal is
// to give the merchant operator enough machine-readable signal to
// debug while leaking no internal state to an attacker probing the
// endpoint.
func writeProblem(w http.ResponseWriter, status int, reason string) {
	body := problemDetails{
		Type:   "about:blank",
		Title:  http.StatusText(status),
		Status: status,
		Error:  reason,
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	// Encoding a small fixed-shape struct cannot fail in practice;
	// ignore the error rather than risk a double-write.
	_ = json.NewEncoder(w).Encode(body)
}

// Re-export commonly used errors from receiptspec so callers do not have
// to import receiptspec just to do errors.Is checks. These are not
// load-bearing for the middleware itself but help when wiring custom
// fallbacks.
var (
	// ErrMissingHeader is returned (wrapped, indirectly via the
	// Problem Details "error" field) when the request has no
	// Payment-Receipt header. Exposed for callers that build their
	// own verifier on top of verify().
	ErrMissingHeader = errors.New("mppmiddleware: missing Payment-Receipt header")
)
