package middleware

import (
	"net/http"
	"strings"
)

// HeaderX402SupportedVersions is the wire-side header that advertises which
// goatx402 versions the facilitator speaks. Browser SDKs read it via JS, so
// it MUST be in Access-Control-Expose-Headers; the name is intentionally
// NOT prefixed with Sec-* because Fetch-spec forbids reading Sec-* response
// headers from JS (PLAN.md §5.1).
const HeaderX402SupportedVersions = "X-X402-Supported-Versions"

// CORSOptions configures CORS. AllowOrigins is the verbatim allowlist; "*" is
// rejected in CANTON_PROD by the config matrix but accepted here for v0 dev
// flexibility (the config layer is the gatekeeper).
type CORSOptions struct {
	AllowOrigins   []string
	AllowMethods   []string // empty → sensible default
	AllowHeaders   []string // empty → sensible default
	ExposeHeaders  []string // X-X402-Supported-Versions is appended automatically.
	AllowCredentials bool
	MaxAge         int // seconds; 0 → 86400.
}

// CORS returns a middleware that enforces the allowlist on every request.
// Preflight (OPTIONS) returns 204 with the allowlist headers; non-OPTIONS
// requests proceed regardless of Origin but only get the CORS headers when the
// Origin is in the allowlist.
func CORS(opts CORSOptions) func(http.Handler) http.Handler {
	allow := make(map[string]struct{}, len(opts.AllowOrigins))
	for _, o := range opts.AllowOrigins {
		allow[o] = struct{}{}
	}
	methods := opts.AllowMethods
	if len(methods) == 0 {
		methods = []string{"GET", "POST", "OPTIONS"}
	}
	headers := opts.AllowHeaders
	if len(headers) == 0 {
		headers = []string{"Content-Type", HeaderXPayerToken, "Authorization"}
	}
	expose := append([]string{HeaderX402SupportedVersions}, opts.ExposeHeaders...)
	maxAge := opts.MaxAge
	if maxAge == 0 {
		maxAge = 86400
	}
	allowAll := false
	for _, o := range opts.AllowOrigins {
		if o == "*" {
			allowAll = true
			break
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			originAllowed := allowAll
			if !originAllowed && origin != "" {
				_, originAllowed = allow[origin]
			}
			if originAllowed && origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				if opts.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Expose-Headers", strings.Join(expose, ", "))
			} else if allowAll {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Expose-Headers", strings.Join(expose, ", "))
			}
			if r.Method == http.MethodOptions {
				if originAllowed || allowAll {
					w.Header().Set("Access-Control-Allow-Methods", strings.Join(methods, ", "))
					w.Header().Set("Access-Control-Allow-Headers", strings.Join(headers, ", "))
					w.Header().Set("Access-Control-Max-Age", itoa(maxAge))
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := make([]byte, 0, 12)
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}
