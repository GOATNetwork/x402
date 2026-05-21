package api

import (
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/api/middleware"
)

// RouterDeps bundles the dependencies the router wires. The resource
// handler does the heavy lifting; everything else is plumbing.
type RouterDeps struct {
	Resource    *Resource
	ResourceURL string

	// CORSOrigins is forwarded to the CORS middleware. Empty disables
	// CORS headers (the merchant will still serve same-origin clients).
	CORSOrigins []string

	// RateLimitRPS / RateLimitBurst configure the per-IP token-bucket
	// applied to ResourceURL only. PLAN.md §5.3 caps at MERCHANT_RESOURCE_RATE_LIMIT.
	RateLimitRPS   float64
	RateLimitBurst int

	// Now is the clock used by the rate-limiter; injectable for tests.
	Now func() time.Time
}

// NewRouter assembles the merchant's HTTP routes. The /resource path is
// the only gated surface; /healthz is unauthenticated and exists so the
// e2e smoke script can wait for readiness.
func NewRouter(deps RouterDeps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// /resource is served under the rate-limiter; everything else is not.
	limiter := newIPRateLimiter(deps.RateLimitRPS, deps.RateLimitBurst, deps.Now)
	mux.Handle(deps.ResourceURL, limiter.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "use GET or POST")
			return
		}
		deps.Resource.ServeHTTP(w, r)
	})))

	cors := middleware.CORS(middleware.CORSConfig{AllowedOrigins: deps.CORSOrigins})
	return cors(mux)
}

// ipRateLimiter is a per-source-IP token-bucket. Implemented in-tree to
// avoid pulling gofiber/contrib/limiter as a dependency. PLAN.md §5.3
// names this knob MERCHANT_RESOURCE_RATE_LIMIT (per-IP token bucket).
type ipRateLimiter struct {
	mu       sync.Mutex
	rps      float64
	burst    int
	buckets  map[string]*bucket
	maxSeen  int
	now      func() time.Time
}

type bucket struct {
	tokens float64
	lastAt time.Time
}

func newIPRateLimiter(rps float64, burst int, now func() time.Time) *ipRateLimiter {
	if now == nil {
		now = time.Now
	}
	if rps <= 0 {
		rps = 1
	}
	if burst <= 0 {
		burst = 1
	}
	return &ipRateLimiter{
		rps:     rps,
		burst:   burst,
		buckets: make(map[string]*bucket),
		// 10k entries is large enough for any merchant demo target and
		// small enough that we are immune to per-IP map exhaustion. The
		// facilitator caps its analogue at RATE_LIMIT_IP_MAP_MAX; here we
		// pin the same default so the merchant cannot be DoS-ed by IP
		// rotation either.
		maxSeen: 10_000,
		now:     now,
	}
}

func (l *ipRateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !l.allow(ip) {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[ip]
	if !ok {
		// Evict an arbitrary entry if the map would grow without bound.
		// A perfect LRU is overkill at this rate budget; deleting a
		// pseudo-random old entry on overflow keeps memory tight.
		if len(l.buckets) >= l.maxSeen {
			for k := range l.buckets {
				delete(l.buckets, k)
				break
			}
		}
		b = &bucket{tokens: float64(l.burst), lastAt: now}
		l.buckets[ip] = b
	} else {
		elapsed := now.Sub(b.lastAt).Seconds()
		b.tokens += elapsed * l.rps
		if b.tokens > float64(l.burst) {
			b.tokens = float64(l.burst)
		}
		b.lastAt = now
	}

	if b.tokens < 1.0 {
		return false
	}
	b.tokens -= 1.0
	return true
}

// clientIP returns the remote IP without port. We deliberately do NOT
// honour X-Forwarded-For — the merchant runs directly exposed in v0 and
// an attacker behind a forged header would otherwise sidestep the
// rate-limit (PLAN.md §5.5).
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
