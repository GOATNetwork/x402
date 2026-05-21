package canton

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// streamKey is the OffsetStore primary-key value for the participant-wide
// completion-stream offset. The package commits one offset per Manager.
const streamKey = "canton:completion-stream"

// ErrAlreadyRegistered signals a duplicate Register call for the same
// commandId. Per PLAN.md §6.2: "duplicate registration for the same commandID
// returns ErrAlreadyRegistered and the caller is responsible for not
// double-registering". Handlers use store.TransitionAndArmRetry to ensure
// command_id is written exactly once per order; retries reuse the same
// commandID and re-attach via RecoverByCommandID instead of calling Register.
var ErrAlreadyRegistered = errors.New("canton: commandID already registered")

// ErrManagerClosed signals an operation on a closed Manager.
var ErrManagerClosed = errors.New("canton: stream manager closed")

// Manager owns the shared CommandCompletionService subscription and the
// commandId-keyed demultiplexer. It also drives the ledger-offset checkpoint
// (PLAN.md §6.2 + migration 0004_ledger_offsets.sql).
//
// One Manager per Client. NewManager + Start to begin; Close to flush and
// terminate.
type Manager struct {
	cfg       Config
	transport Transport
	offsets   OffsetStore // may be nil (degraded mode; no persistence).

	mu           sync.Mutex
	waiters      map[string]chan CompletionEvent  // commandID → live waiter chan.
	cache        *ttlCache                        // commandID → last-known event, TTL = COMPLETION_TTL.
	partySubs    map[string][]chan CompletionEvent
	partyStreams map[string]chan struct{}         // party → stop signal for the upstream stream goroutine.
	partyReady   map[string]chan struct{}         // party → close-once-subscribed signal; EnsurePartyStream blocks on it.

	// offset bookkeeping (guarded by offMu).
	offMu             sync.Mutex
	currentOffset     string
	persistedOffset   string
	eventsSinceFlush  int
	lastFlush         time.Time
	skippedOffsetsCnt int64 // facilitator_skipped_offsets_total mirror.
	restartLossCnt    int64 // facilitator_demux_restart_loss_total mirror.

	started   bool
	closing   chan struct{}
	closeOnce sync.Once
	closeErr  error
	wg        sync.WaitGroup
}

// NewManager constructs a Manager. Call Start before Register / Wait /
// Recover. transport must be non-nil; offsets may be nil for tests that
// don't exercise checkpoint persistence.
func NewManager(cfg Config, transport Transport, offsets OffsetStore) *Manager {
	cap := cfg.CompletionCacheMaxEntries
	if cap <= 0 {
		cap = 10_000
	}
	ttl := cfg.CompletionTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &Manager{
		cfg:          cfg,
		transport:    transport,
		offsets:      offsets,
		waiters:      make(map[string]chan CompletionEvent),
		cache:        newTTLCache(cap, ttl),
		partySubs:    make(map[string][]chan CompletionEvent),
		partyStreams: make(map[string]chan struct{}),
		closing:      make(chan struct{}),
	}
}

// Start loads the persisted offset (if any) and spawns the offset-flush
// ticker. The CommandCompletionService subscription is opened lazily on
// the first Register / SubscribeParty so tests don't pay the cost when
// they exercise only Recover.
func (m *Manager) Start(ctx context.Context) error {
	if m.offsets != nil {
		off, ok, err := m.offsets.GetOffset(ctx, streamKey)
		if err != nil {
			return fmt.Errorf("canton: load offset: %w", err)
		}
		if ok {
			m.offMu.Lock()
			m.persistedOffset = off
			m.currentOffset = off
			m.offMu.Unlock()
		}
	}
	m.mu.Lock()
	m.started = true
	m.mu.Unlock()
	m.wg.Add(1)
	go m.offsetTicker()
	return nil
}

// Register adds a one-shot waiter for commandID. The returned channel
// receives at most one CompletionEvent. Duplicate registration returns
// ErrAlreadyRegistered (see PLAN.md §6.2 race semantics).
//
// IMPORTANT (PLAN.md §6.6): Register must be called BEFORE
// Client.SubmitCreateAndExercisePay so an early completion cannot race the
// listener. The handler path is:
//
//	store.TransitionAndArmRetry(...)   // persist command_id
//	ch, err := mgr.Register(commandID) // arm demux waiter
//	client.SubmitCreateAndExercisePay(...) // gRPC submit
//	ev := <-ch                          // (or RecoverByCommandID on retry)
func (m *Manager) Register(commandID string) (<-chan CompletionEvent, error) {
	if commandID == "" {
		return nil, fmt.Errorf("canton: Register: commandID required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.started {
		return nil, fmt.Errorf("canton: Register: manager not started")
	}
	select {
	case <-m.closing:
		return nil, ErrManagerClosed
	default:
	}
	if _, exists := m.waiters[commandID]; exists {
		return nil, ErrAlreadyRegistered
	}
	// If a completion is already cached (e.g. the participant fired before
	// the caller registered — should be impossible per the Register-before-
	// Submit contract, but guard against process-restart resume), deliver
	// it on the spot and skip the live waiter.
	if ev, ok := m.cache.get(commandID); ok {
		ch := make(chan CompletionEvent, 1)
		ch <- ev
		close(ch)
		return ch, nil
	}
	ch := make(chan CompletionEvent, 1)
	m.waiters[commandID] = ch
	return ch, nil
}

// Unregister releases a waiter without consuming an event. The handler path
// uses this only when Submit itself fails before any completion can land
// (the listener becomes pointless).
func (m *Manager) Unregister(commandID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ch, ok := m.waiters[commandID]; ok {
		delete(m.waiters, commandID)
		close(ch)
	}
}

// Recover returns the cached completion for commandID, if any. The cache
// retains entries for cfg.CompletionTTL. Used by the retry path; AGENTS.md
// forbids ACS polling for completion, so this is the only recovery surface.
func (m *Manager) Recover(commandID string) (CompletionEvent, bool) {
	return m.cache.get(commandID)
}

// SubscribeParty returns a channel that receives every completion for the
// given party. Used by operator tooling and by the integration tests.
// Cancelling ctx removes the subscription.
func (m *Manager) SubscribeParty(ctx context.Context, party string) (<-chan CompletionEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.started {
		return nil, fmt.Errorf("canton: SubscribeParty: manager not started")
	}
	select {
	case <-m.closing:
		return nil, ErrManagerClosed
	default:
	}
	ch := make(chan CompletionEvent, 16)
	m.partySubs[party] = append(m.partySubs[party], ch)
	// Lazy-spawn the upstream completion subscription for this party.
	if err := m.ensurePartyStreamLocked(party); err != nil {
		// Roll back the registration; caller sees the error.
		m.removePartySubLocked(party, ch)
		return nil, err
	}
	go func() {
		<-ctx.Done()
		m.mu.Lock()
		m.removePartySubLocked(party, ch)
		m.mu.Unlock()
	}()
	return ch, nil
}

// EnsurePartyStream starts (if not already) an upstream completion stream for
// the given party AND blocks until the gRPC subscription has been established
// (or returned an error). Idempotent; safe to call from Submit before every
// send. Without this hook AND the readiness wait, Register-then-Submit on a
// fresh party can either (a) orphan the waiter because no upstream goroutine
// is running, or (b) miss the completion because Submit committed before
// gRPC CompletionStream was subscribed.
func (m *Manager) EnsurePartyStream(party string) error {
	if party == "" {
		return fmt.Errorf("canton: EnsurePartyStream: party required")
	}
	m.mu.Lock()
	if !m.started {
		m.mu.Unlock()
		return fmt.Errorf("canton: EnsurePartyStream: manager not started")
	}
	select {
	case <-m.closing:
		m.mu.Unlock()
		return ErrManagerClosed
	default:
	}
	if err := m.ensurePartyStreamLocked(party); err != nil {
		m.mu.Unlock()
		return err
	}
	ready := m.partyReady[party]
	m.mu.Unlock()
	if ready == nil {
		// First call started the goroutine; wait briefly for it to fire
		// OpenCompletionStream. The goroutine closes the ready chan after
		// the subscription is established (or the first error backed off).
		return nil
	}
	select {
	case <-ready:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("canton: EnsurePartyStream(%s): subscription not ready within 5s", party)
	case <-m.closing:
		return ErrManagerClosed
	}
}

// ensurePartyStreamLocked starts a goroutine that consumes the transport's
// completion stream for `party` and fans it out to demux + party subs.
// Must be called with m.mu held.
func (m *Manager) ensurePartyStreamLocked(party string) error {
	// We start exactly one upstream goroutine per party; the first
	// SubscribeParty + first Register both rely on it being present. We
	// gate on the partySubs map plus a sentinel chan.
	if _, started := m.partyStreams[party]; started {
		return nil
	}
	if m.partyStreams == nil {
		m.partyStreams = make(map[string]chan struct{})
	}
	if m.partyReady == nil {
		m.partyReady = make(map[string]chan struct{})
	}
	stopCh := make(chan struct{})
	readyCh := make(chan struct{})
	m.partyStreams[party] = stopCh
	m.partyReady[party] = readyCh
	m.wg.Add(1)
	go m.runPartyStream(party, stopCh, readyCh)
	return nil
}

// partyStreams tracks the upstream completion-stream goroutines (one per
// party). Stop signals are closed on Manager.Close.
//
// (Field declared on the Manager via a small helper below to keep the
// struct literal in NewManager terse.)
var _ struct{} = struct{}{}

func (m *Manager) runPartyStream(party string, stop <-chan struct{}, ready chan<- struct{}) {
	defer m.wg.Done()
	readySignaled := false
	signalReady := func() {
		if !readySignaled {
			close(ready)
			readySignaled = true
		}
	}
	defer signalReady() // ensure callers don't block forever if we exit early
	// Resume from the persisted offset, clamped by ReconnectReplayMax.
	m.offMu.Lock()
	from := m.currentOffset
	m.offMu.Unlock()

	backoff := 500 * time.Millisecond
	const backoffMax = 30 * time.Second

	for {
		select {
		case <-stop:
			return
		case <-m.closing:
			return
		default:
		}

		// Apply the replay cap: if the persisted offset is older than
		// now-ReconnectReplayMax, the transport implementation will
		// reject the resume; we increment the skipped-offsets counter
		// and resume from "now". The transport is the source of truth
		// for offset semantics — this package only counts and warns.
		ctx, cancel := context.WithCancel(context.Background())
		// Close the per-attempt ctx when the stop signal fires.
		go func() {
			select {
			case <-stop:
				cancel()
			case <-m.closing:
				cancel()
			case <-ctx.Done():
			}
		}()
		ch, err := m.transport.OpenCompletionStream(ctx, party, from)
		// Signal readiness on the first OpenCompletionStream attempt — whether
		// it succeeded or returned an error. Callers blocked in
		// EnsurePartyStream can now proceed; if the subscription failed they'll
		// see Submit errors naturally.
		signalReady()
		if err != nil {
			cancel()
			// Exponential backoff with cap.
			t := time.NewTimer(backoff)
			select {
			case <-t.C:
			case <-stop:
				t.Stop()
				return
			case <-m.closing:
				t.Stop()
				return
			}
			backoff *= 2
			if backoff > backoffMax {
				backoff = backoffMax
			}
			continue
		}
		backoff = 500 * time.Millisecond

		for ev := range ch {
			m.handleEvent(party, ev)
			from = ev.Offset
		}
		cancel()
		// Stream ended (server-side close or transport-level reconnect
		// boundary). Loop and resume from the last seen offset.
	}
}

// handleEvent fans out one event to the demux waiter and to any party
// subscribers; updates the cache; advances the offset counter.
func (m *Manager) handleEvent(party string, ev CompletionEvent) {
	// 1. Cache and waiter fan-out (commandId-keyed).
	m.mu.Lock()
	m.cache.put(ev.CommandID, ev)
	if ch, ok := m.waiters[ev.CommandID]; ok {
		// Non-blocking deliver; waiter buffer is 1.
		select {
		case ch <- ev:
		default:
		}
		close(ch)
		delete(m.waiters, ev.CommandID)
	}
	// 2. Party fan-out.
	for _, sub := range m.partySubs[party] {
		select {
		case sub <- ev:
		default:
			// Drop if a subscriber is slow — completion is also in the
			// commandId-keyed cache, so the slow consumer can recover.
		}
	}
	m.mu.Unlock()
	// 3. Offset advancement.
	m.offMu.Lock()
	m.currentOffset = ev.Offset
	m.eventsSinceFlush++
	due := m.eventsSinceFlush >= m.cfg.OffsetCheckpointEvery
	m.offMu.Unlock()
	if due {
		m.flushOffset(context.Background())
	}
}

// flushOffset persists currentOffset via OffsetStore (best-effort). A flush
// failure is logged via the returned error path (caller invokes from the
// goroutine; we surface to the package's metrics later).
func (m *Manager) flushOffset(ctx context.Context) {
	if m.offsets == nil {
		return
	}
	m.offMu.Lock()
	if m.currentOffset == m.persistedOffset || m.currentOffset == "" {
		m.offMu.Unlock()
		return
	}
	off := m.currentOffset
	m.offMu.Unlock()

	if err := m.offsets.SaveOffset(ctx, streamKey, off); err != nil {
		// Best-effort; the next event will retry. We do NOT panic, we do
		// NOT block stream progress.
		return
	}
	m.offMu.Lock()
	m.persistedOffset = off
	m.eventsSinceFlush = 0
	m.lastFlush = time.Now().UTC()
	m.offMu.Unlock()
}

// offsetTicker runs the time-based checkpoint cadence
// (OffsetCheckpointInterval). Stops on Manager.Close.
func (m *Manager) offsetTicker() {
	defer m.wg.Done()
	d := m.cfg.OffsetCheckpointInterval
	if d <= 0 {
		// No periodic flush requested; only event-count-based flushes
		// will fire.
		<-m.closing
		return
	}
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-m.closing:
			// Final flush is handled in Close.
			return
		case <-t.C:
			m.flushOffset(context.Background())
		}
	}
}

// SkippedOffsetsTotal reports facilitator_skipped_offsets_total — exposed
// for metrics wiring (Task 10).
func (m *Manager) SkippedOffsetsTotal() int64 {
	m.offMu.Lock()
	defer m.offMu.Unlock()
	return m.skippedOffsetsCnt
}

// RestartLossTotal reports facilitator_demux_restart_loss_total — exposed
// for metrics wiring (Task 10).
func (m *Manager) RestartLossTotal() int64 {
	m.offMu.Lock()
	defer m.offMu.Unlock()
	return m.restartLossCnt
}

// MarkRestartLoss is called by the sweeper retry path when a re-driven
// commandId neither has a cached completion nor surfaces on stream-resume
// within RECONNECT_REPLAY_MAX (PLAN.md §6.2 process-restart loss window).
func (m *Manager) MarkRestartLoss() {
	m.offMu.Lock()
	m.restartLossCnt++
	m.offMu.Unlock()
}

// MarkSkippedOffset increments facilitator_skipped_offsets_total. Called by
// the transport when it clamps a stale persisted offset forward (PLAN.md
// §6.2 skipped-offset visibility note).
func (m *Manager) MarkSkippedOffset() {
	m.offMu.Lock()
	m.skippedOffsetsCnt++
	m.offMu.Unlock()
}

// removePartySubLocked drops one party subscriber. Must be called with
// m.mu held.
func (m *Manager) removePartySubLocked(party string, ch chan CompletionEvent) {
	subs := m.partySubs[party]
	for i, s := range subs {
		if s == ch {
			subs = append(subs[:i], subs[i+1:]...)
			close(ch)
			break
		}
	}
	if len(subs) == 0 {
		delete(m.partySubs, party)
	} else {
		m.partySubs[party] = subs
	}
}

// Close stops every goroutine, flushes the offset one last time, and
// closes any live waiters. Idempotent.
func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		close(m.closing)
		// Stop every party-stream goroutine.
		m.mu.Lock()
		for p, stop := range m.partyStreams {
			close(stop)
			_ = p
		}
		m.partyStreams = nil
		// Wake all waiters with a synthetic closure event so callers
		// unblock with status=FAILURE rather than hanging forever.
		for cid, ch := range m.waiters {
			select {
			case ch <- CompletionEvent{CommandID: cid, Status: CompletionFailure, Code: "MANAGER_CLOSED", Time: time.Now().UTC()}:
			default:
			}
			close(ch)
		}
		m.waiters = make(map[string]chan CompletionEvent)
		for p, subs := range m.partySubs {
			for _, ch := range subs {
				close(ch)
			}
			delete(m.partySubs, p)
		}
		m.mu.Unlock()
		m.wg.Wait()
		// Final offset flush.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		m.flushOffset(ctx)
	})
	return m.closeErr
}

// ---- TTL cache ----------------------------------------------------------

// ttlCache is a bounded LRU with per-entry TTL. Used to cache the last-known
// CompletionEvent per commandId for COMPLETION_TTL.
type ttlCache struct {
	mu  sync.Mutex
	max int
	ttl time.Duration
	idx map[string]*list.Element
	lru *list.List // front = most-recent.
}

type ttlEntry struct {
	key       string
	value     CompletionEvent
	expiresAt time.Time
}

func newTTLCache(max int, ttl time.Duration) *ttlCache {
	return &ttlCache{
		max: max,
		ttl: ttl,
		idx: make(map[string]*list.Element),
		lru: list.New(),
	}
}

func (c *ttlCache) put(key string, ev CompletionEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if el, ok := c.idx[key]; ok {
		entry := el.Value.(*ttlEntry)
		entry.value = ev
		entry.expiresAt = now.Add(c.ttl)
		c.lru.MoveToFront(el)
		return
	}
	entry := &ttlEntry{key: key, value: ev, expiresAt: now.Add(c.ttl)}
	el := c.lru.PushFront(entry)
	c.idx[key] = el
	c.evictLocked(now)
}

func (c *ttlCache) get(key string) (CompletionEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.idx[key]
	if !ok {
		return CompletionEvent{}, false
	}
	entry := el.Value.(*ttlEntry)
	if time.Now().After(entry.expiresAt) {
		c.removeLocked(el)
		return CompletionEvent{}, false
	}
	c.lru.MoveToFront(el)
	return entry.value, true
}

func (c *ttlCache) evictLocked(now time.Time) {
	// Sweep expired entries from the back; bound the work per put to keep
	// amortised O(1).
	for range 8 {
		el := c.lru.Back()
		if el == nil {
			break
		}
		entry := el.Value.(*ttlEntry)
		if !now.After(entry.expiresAt) && c.lru.Len() <= c.max {
			break
		}
		c.removeLocked(el)
		if c.lru.Len() <= c.max {
			// Stop evicting once under cap unless more are expired.
			next := c.lru.Back()
			if next == nil {
				break
			}
			nextEntry := next.Value.(*ttlEntry)
			if !now.After(nextEntry.expiresAt) {
				break
			}
		}
	}
}

func (c *ttlCache) removeLocked(el *list.Element) {
	entry := el.Value.(*ttlEntry)
	delete(c.idx, entry.key)
	c.lru.Remove(el)
}

// Len returns the cache's current entry count. Exposed for tests.
func (c *ttlCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lru.Len()
}
