// Package middleware holds the per-request gates documented in PLAN.md §5.1
// and §5.5: payer-token authentication, CORS allowlist, token-bucket rate
// limit, and the order-body size cap.
//
// Each middleware is a plain http.Handler wrapper so the wiring in
// internal/api/router.go composes via function chains.
package middleware

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
)

// payerTokenCtxKey is the context key the middleware writes the validated
// token to. Handlers fetch it via PayerTokenFromContext and compare against the
// party they want to bind the request to.
type payerTokenCtxKey struct{}

// PayerTokenStore is the read-only interface required for token lookup. The
// concrete map comes from config.LoadPayerTokens.
type PayerTokenStore interface {
	// TokenFor returns the bound token for party, or (nil, false) if the
	// party has no binding.
	TokenFor(party string) ([]byte, bool)
}

// MapPayerTokenStore wraps a plain map for tests + boot wiring.
type MapPayerTokenStore map[string][]byte

// TokenFor implements PayerTokenStore.
func (m MapPayerTokenStore) TokenFor(party string) ([]byte, bool) {
	t, ok := m[party]
	return t, ok
}

// HeaderXPayerToken is the public wire name. Constant for tests.
const HeaderXPayerToken = "X-Payer-Token"

// RequirePayerToken is a shape-only check: every protected route must have a
// non-empty X-Payer-Token header. The actual binding (token ↔ payer party)
// happens inside the handler via AssertBoundToParty because POST /orders takes
// the party from the body while /:id endpoints take it from the loaded order.
//
// Handlers that fail AssertBoundToParty write the canonical 401/403 envelope
// and emit an audit row (audit emission lives in the handler so it has access
// to the store; the middleware is route-agnostic).
func RequirePayerToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get(HeaderXPayerToken)
		if tok == "" {
			writeUnauth(w)
			return
		}
		ctx := context.WithValue(r.Context(), payerTokenCtxKey{}, tok)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// PayerTokenFromContext extracts the validated raw token from ctx. Returns
// "" when RequirePayerToken did not run.
func PayerTokenFromContext(ctx context.Context) string {
	v, _ := ctx.Value(payerTokenCtxKey{}).(string)
	return v
}

// AssertBoundToParty performs the constant-time binding check. The supplied
// token (already extracted from the header / context) must base64-decode to a
// byte string that equals the per-party token in the store.
//
// Returns (true, nil) on success; (false, "UNAUTHENTICATED"|"PAYER_NOT_BOUND")
// otherwise. Callers project the second value into the wire envelope.
func AssertBoundToParty(token, party string, store PayerTokenStore) (ok bool, code string) {
	if token == "" {
		return false, "UNAUTHENTICATED"
	}
	if party == "" || store == nil {
		return false, "UNAUTHENTICATED"
	}
	bound, exists := store.TokenFor(party)
	if !exists {
		return false, "PAYER_NOT_BOUND"
	}
	// Wire tokens are base64; handlers receive the raw base64 string. We
	// compare in constant time against the decoded bytes. If the wire token
	// is not valid base64, the compare against decoded bytes will fail (the
	// raw bytes are constant-time compared too).
	if subtle.ConstantTimeCompare([]byte(token), encodeForCompare(bound)) == 1 {
		return true, ""
	}
	return false, "PAYER_NOT_BOUND"
}

// encodeForCompare materialises the bound token's expected wire form. The
// PAYER_TOKEN_FILE stores tokens base64-encoded, and clients send the base64
// string verbatim — config.LoadPayerTokens decodes to raw bytes for in-memory
// storage; here we re-encode so the constant-time compare runs over the wire
// representation the client actually transmits.
func encodeForCompare(raw []byte) []byte {
	// Re-encode at compare time so the in-process form never goes through
	// untyped string concatenation. Same length every call → constant-time
	// safe.
	return []byte(base64StdNoPad(raw))
}

// base64StdNoPad encodes b using the same StdEncoding form the
// PAYER_TOKEN_FILE stores. Kept as a tiny helper so other middleware can
// reuse it without re-importing encoding/base64.
func base64StdNoPad(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// writeUnauth emits the canonical 401 envelope; duplicated locally so this
// middleware file has zero deps on the parent api package.
func writeUnauth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"UNAUTHENTICATED","message":"X-Payer-Token required"}`))
}
