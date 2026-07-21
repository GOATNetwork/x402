// Package middleware holds the merchant's shared HTTP middlewares.
//
// The CORS middleware mirrors the facilitator's allowlist semantics
// (PLAN.md §5.5): origins come from CORS_ORIGINS, OPTIONS preflight is
// short-circuited, and X-X402-Supported-Versions is exposed so the
// browser SDK can read it (resolves the Sec-* unreadable-header gotcha
// called out in PLAN.md §5.1 / §5.5).
package middleware

import (
	"net/http"
)

// CORSConfig drives the CORS handler. Keep tiny: the demo only needs a
// static allowlist.
type CORSConfig struct {
	// AllowedOrigins is an exact-match allowlist; "*" is treated as a
	// wildcard but only when it is the sole entry, to discourage
	// accidental loose configs.
	AllowedOrigins []string
}

// allowedMethods is the request-method subset the merchant accepts.
// PLAN.md §5.3 names GET and POST on /resource; OPTIONS is the preflight.
var allowedMethods = "GET, POST, OPTIONS"

// exposedHeaders is appended verbatim to Access-Control-Expose-Headers so
// browser SDKs can read the version-advertise header (PLAN.md §5.5).
var exposedHeaders = "X-X402-Supported-Versions"

// allowedRequestHeaders is the comma-separated set merchants accept on
// preflight. X-PAYMENT is the receipt-carrying header; Content-Type is
// here because the browser fetch shim sets it on POST.
var allowedRequestHeaders = "Content-Type, X-PAYMENT"

// CORS returns a middleware that injects the headers and short-circuits
// preflights. Requests whose Origin is not allowlisted are forwarded
// without CORS headers (the browser will block them client-side); non-
// preflight requests with no Origin pass through unchanged.
func CORS(cfg CORSConfig) func(http.Handler) http.Handler {
	allowlist := make(map[string]struct{}, len(cfg.AllowedOrigins))
	wildcard := false
	if len(cfg.AllowedOrigins) == 1 && cfg.AllowedOrigins[0] == "*" {
		wildcard = true
	} else {
		for _, o := range cfg.AllowedOrigins {
			allowlist[o] = struct{}{}
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (wildcard || allowed(allowlist, origin)) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Expose-Headers", exposedHeaders)
				w.Header().Set("Access-Control-Allow-Methods", allowedMethods)
				w.Header().Set("Access-Control-Allow-Headers", allowedRequestHeaders)
			}

			if r.Method == http.MethodOptions {
				// Preflight: respond 204 with the headers above already set.
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func allowed(set map[string]struct{}, origin string) bool {
	_, ok := set[origin]
	return ok
}
