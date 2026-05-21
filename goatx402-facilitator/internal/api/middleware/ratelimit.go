package middleware

import (
	"container/list"
	"net"
	"net/http"
	"sync"
	"time"
)

// RateLimitOptions configures the per-token + per-IP token-bucket. The map
// of per-IP buckets is bounded at IPMapMax with LRU-evict so a coordinated
// 401-spam from many IPs cannot exhaust memory (PLAN.md §5.5).
type RateLimitOptions struct {
	// PerTokenRPS is the steady-state rate per X-Payer-Token.
	PerTokenRPS float64
	// PerIPRPS is the steady-state rate per source IP (used when the
	// token header is missing — PLAN.md §5.5 fallback).
	PerIPRPS float64
	// BurstToken / BurstIP — bucket size. Default = ceil(rate).
	BurstToken int
	BurstIP    int
	// IPMapMax bounds the per-IP map.
	IPMapMax int
	// Now is the clock for deterministic tests.
	Now func() time.Time
}

// RateLimit returns a middleware enforcing the configured token-bucket. The
// returned middleware is safe for concurrent use.
func RateLimit(opts RateLimitOptions) func(http.Handler) http.Handler {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.BurstToken <= 0 {
		opts.BurstToken = burstFromRate(opts.PerTokenRPS)
	}
	if opts.BurstIP <= 0 {
		opts.BurstIP = burstFromRate(opts.PerIPRPS)
	}
	if opts.IPMapMax <= 0 {
		opts.IPMapMax = 100_000
	}
	tokens := &bucketStore{
		buckets:  map[string]*list.Element{},
		lru:      list.New(),
		rate:     opts.PerTokenRPS,
		burst:    opts.BurstToken,
		cap:      opts.IPMapMax * 4, // tokens are scarcer than IPs but bound anyway.
		nowFn:    opts.Now,
	}
	ips := &bucketStore{
		buckets:  map[string]*list.Element{},
		lru:      list.New(),
		rate:     opts.PerIPRPS,
		burst:    opts.BurstIP,
		cap:      opts.IPMapMax,
		nowFn:    opts.Now,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			tok := r.Header.Get(HeaderXPayerToken)
			// PLAN.md §5.5: when the token header is missing/invalid we
			// fall back to per-IP only (this is the 401-spam path).
			if tok != "" {
				if !tokens.allow(tok) {
					rateLimited(w)
					return
				}
			}
			if !ips.allow(ip) {
				rateLimited(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func rateLimited(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "1")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"error":"RATE_LIMITED","message":"rate limit exceeded"}`))
}

// burstFromRate provides a sensible default burst when callers leave the
// field zero: floor(rate) but at least 1.
func burstFromRate(rate float64) int {
	if rate <= 1 {
		return 1
	}
	return int(rate)
}

func clientIP(r *http.Request) string {
	// Prefer XFF when set (we trust the operator's reverse proxy in front;
	// per PLAN.md §5.5 the rate limit is a defence-in-depth knob, not a
	// security primitive). Fall back to RemoteAddr.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return trim(xff[:i])
			}
		}
		return trim(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func trim(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

// bucketStore is a bounded LRU of token buckets. Each entry refreshes on
// access; entries beyond cap are evicted from the back of the LRU.
type bucketStore struct {
	mu       sync.Mutex
	buckets  map[string]*list.Element
	lru      *list.List
	rate     float64
	burst    int
	cap      int
	nowFn    func() time.Time
}

type bucketEntry struct {
	key       string
	tokens    float64
	updatedAt time.Time
}

// allow attempts to debit one token from the bucket keyed by key. It returns
// false when the bucket is empty (rate-limited).
func (s *bucketStore) allow(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.nowFn()
	if el, ok := s.buckets[key]; ok {
		entry := el.Value.(*bucketEntry)
		elapsed := now.Sub(entry.updatedAt).Seconds()
		if elapsed > 0 {
			entry.tokens += elapsed * s.rate
			if entry.tokens > float64(s.burst) {
				entry.tokens = float64(s.burst)
			}
			entry.updatedAt = now
		}
		if entry.tokens >= 1.0 {
			entry.tokens -= 1.0
			s.lru.MoveToFront(el)
			return true
		}
		s.lru.MoveToFront(el)
		return false
	}
	// New entry — burst-1 tokens consumed by this request.
	entry := &bucketEntry{key: key, tokens: float64(s.burst) - 1.0, updatedAt: now}
	if entry.tokens < 0 {
		entry.tokens = 0
	}
	el := s.lru.PushFront(entry)
	s.buckets[key] = el
	// Evict from the back until under cap.
	for s.lru.Len() > s.cap {
		back := s.lru.Back()
		if back == nil {
			break
		}
		old := back.Value.(*bucketEntry)
		delete(s.buckets, old.key)
		s.lru.Remove(back)
	}
	return true
}

// Len reports the current LRU size (tests only).
func (s *bucketStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lru.Len()
}
