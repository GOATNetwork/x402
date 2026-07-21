package middleware

import (
	"net/http"
)

// BodyLimit returns a middleware that wraps r.Body in an http.MaxBytesReader.
// A request whose body exceeds max returns 413 PAYLOAD_TOO_LARGE before
// reaching the handler — same observable behaviour as Fiber's BodyLimit
// middleware named in PLAN.md Task 9 spec.
func BodyLimit(max int64) func(http.Handler) http.Handler {
	if max <= 0 {
		// 0 disables the cap — caller error; treat as a passthrough.
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, max)
			}
			// We peek at ContentLength so a client that advertises a too-large
			// body fails fast without buffering anything.
			if r.ContentLength > max {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				_, _ = w.Write([]byte(`{"error":"PAYLOAD_TOO_LARGE","message":"request body exceeds limit"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
