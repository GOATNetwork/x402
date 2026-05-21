// Package replay provides the two bounded LRU caches the merchant relies on
// to make the x402 round trip race-safe:
//
//  1. ReceiptReplay tracks one-time-use receipts keyed by (ledgerId,
//     transactionId). Consume returns ErrAlreadyConsumed on the second call
//     for the same key, which the resource handler maps to 409.
//  2. IssuedNonces maps a server-generated merchantRequestId to the
//     ChallengeTuple it was minted under. The verifier looks the entry up
//     atomically and compares every tuple field; an unknown nonce maps to
//     400 UNKNOWN_CHALLENGE and a tuple mismatch maps to 400
//     RECEIPT_MISMATCH.
//
// Both caches are sync.Mutex-guarded so the -race acceptance test in
// PLAN.md §5.3 can fire 100 concurrent verifies of the same receipt and
// observe exactly one 200 and 99 × 409.
package replay

import (
	"container/list"
	"errors"
	"sync"
	"time"
)

// ErrAlreadyConsumed is returned by ReceiptReplay.Consume when the key is
// already present in the cache (replay attempt).
var ErrAlreadyConsumed = errors.New("replay: receipt already consumed")

// ChallengeTuple is the {merchant, resource, amount, currency,
// trustedIssuer} bundle that uniquely identifies a 402 challenge. The full
// tuple — not just the nonce — is what the merchant compares against the
// receipt, which closes the cross-challenge nonce-reuse surface called out
// in PLAN.md §6.7.
type ChallengeTuple struct {
	Merchant      string
	Resource      string
	Amount        string
	Currency      string
	TrustedIssuer string
}

// ReceiptReplay is a bounded LRU of receipt keys with atomic
// try-and-insert semantics.
type ReceiptReplay struct {
	mu    sync.Mutex
	max   int
	items map[string]*list.Element
	order *list.List
}

// NewReceiptReplay returns a replay cache with the given upper bound.
// A non-positive bound is treated as 1 so the cache always evicts.
func NewReceiptReplay(max int) *ReceiptReplay {
	if max <= 0 {
		max = 1
	}
	return &ReceiptReplay{
		max:   max,
		items: make(map[string]*list.Element, max),
		order: list.New(),
	}
}

// Consume atomically inserts key. If key was already present it returns
// ErrAlreadyConsumed; otherwise it inserts, evicting the LRU tail when the
// cache is full, and returns nil.
func (r *ReceiptReplay) Consume(key string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.items[key]; ok {
		return ErrAlreadyConsumed
	}

	elem := r.order.PushFront(key)
	r.items[key] = elem

	if r.order.Len() > r.max {
		tail := r.order.Back()
		if tail != nil {
			r.order.Remove(tail)
			if s, ok := tail.Value.(string); ok {
				delete(r.items, s)
			}
		}
	}
	return nil
}

// Len returns the current number of cached receipts. Exposed for tests.
func (r *ReceiptReplay) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.order.Len()
}

// IssuedNonces tracks merchantRequestId -> ChallengeTuple with a TTL set by
// the operator (PLAN.md §5.3 fixes TTL = 2 × RECEIPT_MAX_AGE).
type IssuedNonces struct {
	mu    sync.Mutex
	max   int
	ttl   time.Duration
	now   func() time.Time
	items map[string]*list.Element
	order *list.List
}

type nonceEntry struct {
	nonce     string
	tuple     ChallengeTuple
	expiresAt time.Time
}

// NewIssuedNonces returns a TTL-bounded LRU. The clock is injectable so
// tests can drive expiry without sleeping.
func NewIssuedNonces(max int, ttl time.Duration, now func() time.Time) *IssuedNonces {
	if max <= 0 {
		max = 1
	}
	if now == nil {
		now = time.Now
	}
	return &IssuedNonces{
		max:   max,
		ttl:   ttl,
		now:   now,
		items: make(map[string]*list.Element, max),
		order: list.New(),
	}
}

// Issue stores nonce -> tuple, evicting the LRU tail or any expired entries
// first.
func (n *IssuedNonces) Issue(nonce string, tuple ChallengeTuple) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.evictExpiredLocked()

	if existing, ok := n.items[nonce]; ok {
		// Refresh the tuple + expiry on a re-issuance with the same nonce.
		// Same-nonce re-use is unlikely (we mint 16 random bytes) but the
		// LRU contract should be invariant under it.
		n.order.Remove(existing)
		delete(n.items, nonce)
	}

	entry := &nonceEntry{nonce: nonce, tuple: tuple, expiresAt: n.now().Add(n.ttl)}
	elem := n.order.PushFront(entry)
	n.items[nonce] = elem

	if n.order.Len() > n.max {
		tail := n.order.Back()
		if tail != nil {
			n.order.Remove(tail)
			if e, ok := tail.Value.(*nonceEntry); ok {
				delete(n.items, e.nonce)
			}
		}
	}
}

// MatchResult discriminates the three outcomes the verifier needs to
// distinguish so the handler can emit the right HTTP error.
type MatchResult int

const (
	// MatchOK means the nonce is present and every ChallengeTuple field
	// byte-equals the receipt.
	MatchOK MatchResult = iota
	// MatchUnknown means the nonce was never issued or has expired/been
	// evicted from the cache (→ 400 UNKNOWN_CHALLENGE).
	MatchUnknown
	// MatchTupleMismatch means the nonce is present but a tuple field
	// differs (→ 400 RECEIPT_MISMATCH).
	MatchTupleMismatch
)

// Match atomically looks up nonce and compares the stored tuple to want.
// Expired entries are evicted lazily before the lookup. The comparison and
// the eviction happen under the same mutex so a concurrent verifier cannot
// observe a half-state.
func (n *IssuedNonces) Match(nonce string, want ChallengeTuple) MatchResult {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.evictExpiredLocked()

	elem, ok := n.items[nonce]
	if !ok {
		return MatchUnknown
	}
	entry, _ := elem.Value.(*nonceEntry)
	if entry.tuple != want {
		return MatchTupleMismatch
	}
	return MatchOK
}

// Len returns the live (non-expired) entry count. Exposed for tests.
func (n *IssuedNonces) Len() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.evictExpiredLocked()
	return n.order.Len()
}

func (n *IssuedNonces) evictExpiredLocked() {
	cutoff := n.now()
	for {
		tail := n.order.Back()
		if tail == nil {
			return
		}
		entry, _ := tail.Value.(*nonceEntry)
		if entry.expiresAt.After(cutoff) {
			return
		}
		n.order.Remove(tail)
		delete(n.items, entry.nonce)
	}
}
