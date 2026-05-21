package replay_test

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/replay"
)

func TestReceiptReplay_FirstConsumeSucceeds(t *testing.T) {
	r := replay.NewReceiptReplay(100)
	if err := r.Consume("k1"); err != nil {
		t.Fatalf("first Consume: %v", err)
	}
}

func TestReceiptReplay_SecondConsumeFails(t *testing.T) {
	r := replay.NewReceiptReplay(100)
	_ = r.Consume("k1")
	if err := r.Consume("k1"); err != replay.ErrAlreadyConsumed {
		t.Fatalf("second Consume: want ErrAlreadyConsumed, got %v", err)
	}
}

func TestReceiptReplay_EvictsOldestWhenFull(t *testing.T) {
	r := replay.NewReceiptReplay(2)
	_ = r.Consume("a")
	_ = r.Consume("b")
	_ = r.Consume("c") // evicts "a"

	if err := r.Consume("a"); err != nil {
		t.Fatalf("after eviction, re-consume should succeed: %v", err)
	}
	if r.Len() != 2 {
		t.Fatalf("len: want 2, got %d", r.Len())
	}
}

// TestReceiptReplay_ConcurrentSingleSuccess fires 100 goroutines all racing
// to Consume the same key. Exactly one must succeed; the rest see
// ErrAlreadyConsumed. This pins the PLAN.md §5.3 acceptance: "concurrent
// verifies of the same receipt return exactly one 200 and the rest 409
// (-race test, 100 goroutines)".
func TestReceiptReplay_ConcurrentSingleSuccess(t *testing.T) {
	r := replay.NewReceiptReplay(1000)
	const N = 100

	var wg sync.WaitGroup
	var success, replays int64
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			if err := r.Consume("the-one-receipt"); err == nil {
				atomic.AddInt64(&success, 1)
			} else {
				atomic.AddInt64(&replays, 1)
			}
		}()
	}
	wg.Wait()

	if success != 1 {
		t.Fatalf("want exactly 1 success, got %d", success)
	}
	if replays != N-1 {
		t.Fatalf("want %d replays, got %d", N-1, replays)
	}
}

func TestIssuedNonces_MatchOK(t *testing.T) {
	tuple := replay.ChallengeTuple{Merchant: "m", Resource: "/r", Amount: "1.0", Currency: "USD", TrustedIssuer: "i"}
	n := replay.NewIssuedNonces(100, time.Minute, time.Now)
	n.Issue("nonce-1", tuple)
	if got := n.Match("nonce-1", tuple); got != replay.MatchOK {
		t.Fatalf("Match: want OK, got %v", got)
	}
}

func TestIssuedNonces_MatchUnknown(t *testing.T) {
	n := replay.NewIssuedNonces(100, time.Minute, time.Now)
	if got := n.Match("never-issued", replay.ChallengeTuple{}); got != replay.MatchUnknown {
		t.Fatalf("Match: want Unknown, got %v", got)
	}
}

func TestIssuedNonces_MatchTupleMismatch(t *testing.T) {
	tuple := replay.ChallengeTuple{Merchant: "m", Resource: "/r", Amount: "1.0", Currency: "USD", TrustedIssuer: "i"}
	n := replay.NewIssuedNonces(100, time.Minute, time.Now)
	n.Issue("nonce-1", tuple)

	wrong := tuple
	wrong.Amount = "9999.99"
	if got := n.Match("nonce-1", wrong); got != replay.MatchTupleMismatch {
		t.Fatalf("Match: want TupleMismatch, got %v", got)
	}
}

// TestIssuedNonces_TTLExpiry asserts an entry past TTL is treated as
// Unknown. PLAN.md §5.3 fixes TTL = 2 × RECEIPT_MAX_AGE.
func TestIssuedNonces_TTLExpiry(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_000_000, 0)}
	n := replay.NewIssuedNonces(100, 10*time.Second, clock.Now)
	tuple := replay.ChallengeTuple{Merchant: "m"}
	n.Issue("nonce-1", tuple)

	clock.Advance(11 * time.Second)
	if got := n.Match("nonce-1", tuple); got != replay.MatchUnknown {
		t.Fatalf("after TTL: want Unknown, got %v", got)
	}
}

func TestIssuedNonces_BoundsEnforced(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_000_000, 0)}
	n := replay.NewIssuedNonces(2, time.Hour, clock.Now)
	t1 := replay.ChallengeTuple{Merchant: "m1"}
	t2 := replay.ChallengeTuple{Merchant: "m2"}
	t3 := replay.ChallengeTuple{Merchant: "m3"}
	n.Issue("a", t1)
	n.Issue("b", t2)
	n.Issue("c", t3) // evicts "a"

	if got := n.Match("a", t1); got != replay.MatchUnknown {
		t.Fatalf("expected eviction of oldest, got %v", got)
	}
	if got := n.Match("c", t3); got != replay.MatchOK {
		t.Fatalf("newest should match, got %v", got)
	}
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
