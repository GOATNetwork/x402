package canton

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ---- Public types --------------------------------------------------------

// CreateAndExercisePayInput is the parameter bundle for a single atomic
// createAndExercise of PaymentRequest + Pay (PLAN.md §6.1 + §6.2).
//
// OrderID is also used verbatim as the Canton-layer commandId — see the
// commandId pinning note in doc.go. NewSubmitRequest in command.go enforces
// byte-identity between OrderID and the wire-level commandId.
type CreateAndExercisePayInput struct {
	OrderID                 string // UUIDv7; also the pinned commandId.
	Payer                   string // actAs party for the submission.
	Merchant                string
	Amount                  string
	Currency                string
	TrustedIssuer           string
	SourceHoldingContractID string
	MerchantRequestID       string
	Resource                string
	Nonce                   string
	DedupKey                string // hex(sha256(CanonicalDedupInput)).
	ExpiresAtHTTPSeconds    int64
	ExpiresAtDamlSeconds    int64
	// Deadline is the per-submit deadline_duration on the gRPC call. Caller
	// supplies a per-request value; the package clamps it to a sane default
	// when zero.
	Deadline time.Duration
}

// CreateAndExercisePayOutput is the participant-acknowledgement payload —
// non-waiting, so this only attests that the participant accepted the
// command for submission. The eventual ledger commit (or rejection) is
// delivered out-of-band via SubscribeCompletions.
type CreateAndExercisePayOutput struct {
	CommandID   string
	SubmittedAt time.Time
}

// CompletionStatus is the result class carried on a CompletionEvent.
type CompletionStatus string

const (
	// CompletionSuccess — the command committed; TxID is populated.
	CompletionSuccess CompletionStatus = "SUCCESS"
	// CompletionFailure — the command was rejected; Code/Message carry the
	// gRPC status used by the §6.2 error map.
	CompletionFailure CompletionStatus = "FAILURE"
)

// CompletionEvent is the demux's payload — one per commandId, carrying both
// the success path (TxID populated, Status=SUCCESS) and the failure path
// (Code+Message populated, Status=FAILURE). Source: gRPC
// CommandCompletionService.CompletionStream.
type CompletionEvent struct {
	CommandID string
	TxID      string // empty on failure.
	Status    CompletionStatus
	Code      string // gRPC code on failure; empty on success.
	Message   string // human-readable detail; redact-safe.
	Offset    string // ledger offset of the completion record.
	Time      time.Time
}

// TransactionDetails is the GetTransactionByID payload — used for receipt
// construction only. Never used to detect failure (failures don't commit).
type TransactionDetails struct {
	TxID                     string
	LedgerID                 string
	Offset                   string
	PaymentRequestContractID string
	HoldingContractID        string // post-Pay (merchant's new holding).
	EffectiveAt              time.Time
	Events                   []TransactionEvent
}

// TransactionEvent is one event inside a confirmed transaction (created or
// exercised). Payload carries the Daml field values relevant to receipt
// construction; it is a generic map so this package does not need to know
// the Daml record shapes (those live in the daml/ package).
type TransactionEvent struct {
	Kind       string // "created" | "exercised".
	ContractID string
	TemplateID string
	Payload    map[string]any
}

// ---- Client interface ----------------------------------------------------

// Client is the boundary every other facilitator package crosses to reach
// the Canton Ledger API. Per AGENTS.md, tests that exercise ledger
// behaviour must NOT mock this interface — they run against a real
// participant.
type Client interface {
	// SubmitCreateAndExercisePay issues a non-waiting gRPC
	// CommandSubmissionService.Submit for a single createAndExercise of
	// PaymentRequest + Pay. The call returns as soon as the participant
	// accepts the command (not on mediator-confirm); the eventual outcome
	// is delivered via SubscribeCompletions.
	SubmitCreateAndExercisePay(ctx context.Context, in CreateAndExercisePayInput) (CreateAndExercisePayOutput, error)

	// SubscribeCompletions consumes gRPC
	// CommandCompletionService.CompletionStream for the given party.
	// Success and failure both surface here. Implementations multiplex
	// across all callers using the shared tx_stream Manager.
	SubscribeCompletions(ctx context.Context, partyID string) (<-chan CompletionEvent, error)

	// GetTransactionByID retrieves confirmed transaction details (events,
	// contract ids) for receipt construction. Filtered by the txId carried
	// in CompletionEvent. NEVER used as the primary completion signal.
	GetTransactionByID(ctx context.Context, txID string) (TransactionDetails, error)

	// RecoverByCommandID returns the last-known completion for a commandId
	// from the demux cache (TTL = COMPLETION_TTL). Used by the sweeper /
	// "Aborted (dedup) on retry" path so a retry that races a successful
	// original submission does not need to re-poll the ledger or fall back
	// to ACS scans (AGENTS.md forbids ACS polling for completion).
	RecoverByCommandID(ctx context.Context, commandID string) (CompletionEvent, bool, error)

	// Health pings the participant. Returns nil when ready.
	Health(ctx context.Context) error

	// AllocateParty is the bootstrap-only idempotent helper used by
	// scripts/canton-up.sh. Allocating an already-allocated party is a
	// no-op that returns the existing party id.
	AllocateParty(ctx context.Context, hint string) (string, error)

	// Close releases the demux goroutines, flushes the ledger offset, and
	// tears down gRPC streams. Idempotent.
	Close() error
}

// ---- Configuration -------------------------------------------------------

// Config carries every tunable that PLAN.md §6.2 documents. Defaults match
// the plan; callers supply concrete values from internal/config (Task 9).
type Config struct {
	// GRPCAddr is the Canton participant's Ledger API gRPC endpoint.
	GRPCAddr string
	// JSONAddr is the JSON Ledger API base URL (used for Health and
	// AllocateParty only).
	JSONAddr string
	// LedgerID identifies the ledger; mirrored into the receipt.
	LedgerID string

	// CompletionTTL — how long the demux retains the last-known event per
	// commandId, backing RecoverByCommandID. Default 10 minutes.
	CompletionTTL time.Duration

	// DeduplicationDuration carried on every Submit. Must be >=
	// CompletionTTL (boot check). Default = CompletionTTL.
	DeduplicationDuration time.Duration

	// MaxDeduplicationDuration is the upper bound the participant's domain
	// parameters advertise (read at boot via LedgerConfigurationService;
	// falls back to MaxDeduplicationDurationFallback when unavailable).
	// CompletionTTL must be <= this value or boot fails.
	MaxDeduplicationDuration time.Duration

	// MaxDeduplicationDurationFallback — hard ceiling applied when the
	// participant query is unavailable. Default 24h (PLAN.md §6.2).
	MaxDeduplicationDurationFallback time.Duration

	// RetryWindowMax is the sweeper's worst-case retry window. Must be <
	// CompletionTTL (boot check). Default 60s.
	RetryWindowMax time.Duration

	// SubmitDeadline is the default deadline_duration carried on each
	// Submit when CreateAndExercisePayInput.Deadline is zero. Default 5s.
	SubmitDeadline time.Duration

	// MaxInflightPay caps the in-flight Submit/Wait pairs. Default 256.
	MaxInflightPay int

	// CompletionCacheMaxEntries bounds the demux cache. Default 10 000.
	CompletionCacheMaxEntries int

	// OffsetCheckpointEvery — flush the ledger offset every N events.
	OffsetCheckpointEvery int
	// OffsetCheckpointInterval — flush the offset every D regardless of
	// event count.
	OffsetCheckpointInterval time.Duration
	// ReconnectReplayMax — bound on stream resume cost; if the persisted
	// offset is older than now-ReconnectReplayMax the manager resumes from
	// the clamped point and increments facilitator_skipped_offsets_total.
	ReconnectReplayMax time.Duration

	// LAPIHTTPTimeout — timeout for JSON LAPI calls (Health, AllocateParty).
	LAPIHTTPTimeout time.Duration
	// LAPIMaxIdleConns — HTTP transport pool size for JSON LAPI.
	LAPIMaxIdleConns int
	// LAPIMaxConcurrentRequests — caps HTTP client-level concurrency.
	LAPIMaxConcurrentRequests int

	// GRPCKeepaliveTime / GRPCKeepaliveTimeout — gRPC keepalive parameters.
	GRPCKeepaliveTime    time.Duration
	GRPCKeepaliveTimeout time.Duration

	// FacilitatorActAs is the operator party used for v0 localnet (the
	// participant user that has actAs for every allocated payer). In
	// CANTON_PROD the per-request actAs comes from order.payer; this field
	// is unused.
	FacilitatorActAs string

	// CantonProd is the production-mode flag. When true: JWT-backed auth is
	// required, plain key files are rejected, all gRPC dials use TLS.
	CantonProd bool
}

// DefaultConfig returns a Config populated with the PLAN.md §6.2 defaults.
// Callers must set GRPCAddr / JSONAddr / LedgerID; the rest can stay at
// defaults during development.
func DefaultConfig() Config {
	return Config{
		CompletionTTL:                    10 * time.Minute,
		DeduplicationDuration:            10 * time.Minute,
		MaxDeduplicationDuration:         0, // 0 = "ask participant; fall back to ...Fallback".
		MaxDeduplicationDurationFallback: 24 * time.Hour,
		RetryWindowMax:                   60 * time.Second,
		SubmitDeadline:                   5 * time.Second,
		MaxInflightPay:                   256,
		CompletionCacheMaxEntries:        10_000,
		OffsetCheckpointEvery:            100,
		OffsetCheckpointInterval:         5 * time.Second,
		ReconnectReplayMax:               10 * time.Minute,
		LAPIHTTPTimeout:                  5 * time.Second,
		LAPIMaxIdleConns:                 32,
		LAPIMaxConcurrentRequests:        256,
		GRPCKeepaliveTime:                30 * time.Second,
		GRPCKeepaliveTimeout:             10 * time.Second,
	}
}

// ErrInvalidConfig signals that NewClient refused to boot because one of the
// §6.2 invariants is violated. Operators must fix the env and restart.
var ErrInvalidConfig = errors.New("canton: invalid config")

// Validate enforces the boot-time invariants from PLAN.md §6.2:
//
//	(1) RetryWindowMax < CompletionTTL — so RecoverByCommandID can find the
//	    original completion before TTL eviction during a retry.
//	(2) DeduplicationDuration >= CompletionTTL — so Canton's own dedup
//	    window covers the entire facilitator-side retry window.
//	(3) CompletionTTL <= effectiveMaxDedup (Validate uses
//	    MaxDeduplicationDuration when non-zero; otherwise the Fallback) —
//	    prevents the silent-failure mode where every submit fails with
//	    INVALID_DEDUPLICATION_PERIOD after an operator sets COMPLETION_TTL
//	    longer than the domain parameter permits.
//
// Validate is also called from NewClient; callers may invoke it directly to
// fail fast at config-load time (config_prod_test.go).
func (c Config) Validate() error {
	if c.CompletionTTL <= 0 {
		return fmt.Errorf("%w: CompletionTTL must be > 0 (got %s)", ErrInvalidConfig, c.CompletionTTL)
	}
	if c.RetryWindowMax <= 0 {
		return fmt.Errorf("%w: RetryWindowMax must be > 0 (got %s)", ErrInvalidConfig, c.RetryWindowMax)
	}
	if c.DeduplicationDuration <= 0 {
		return fmt.Errorf("%w: DeduplicationDuration must be > 0 (got %s)", ErrInvalidConfig, c.DeduplicationDuration)
	}
	if c.RetryWindowMax >= c.CompletionTTL {
		return fmt.Errorf(
			"%w: RetryWindowMax (%s) must be < CompletionTTL (%s) — see PLAN.md §6.2",
			ErrInvalidConfig, c.RetryWindowMax, c.CompletionTTL,
		)
	}
	if c.DeduplicationDuration < c.CompletionTTL {
		return fmt.Errorf(
			"%w: DeduplicationDuration (%s) must be >= CompletionTTL (%s) — see PLAN.md §6.2",
			ErrInvalidConfig, c.DeduplicationDuration, c.CompletionTTL,
		)
	}
	effectiveMaxDedup := c.MaxDeduplicationDuration
	if effectiveMaxDedup <= 0 {
		effectiveMaxDedup = c.MaxDeduplicationDurationFallback
	}
	if effectiveMaxDedup <= 0 {
		return fmt.Errorf("%w: MaxDeduplicationDurationFallback must be > 0", ErrInvalidConfig)
	}
	if c.CompletionTTL > effectiveMaxDedup {
		return fmt.Errorf(
			"%w: CompletionTTL (%s) > maxDeduplicationDuration (%s) — see PLAN.md §6.2",
			ErrInvalidConfig, c.CompletionTTL, effectiveMaxDedup,
		)
	}
	return nil
}

// ---- Transport seam ------------------------------------------------------

// Transport is the gRPC-shaped abstraction the Client impl drives. It is
// intentionally narrow: every method on this interface corresponds to one
// LAPI gRPC call or one JSON LAPI bootstrap helper (the JSON LAPI is only
// used for Health and AllocateParty per PLAN.md §6.2 — JSON LAPI is never
// used for command submission).
//
// The seam exists so Task 9 can wire a concrete grpc-go-backed impl without
// fanning gRPC types out across the package; tests inject a deterministic
// in-memory impl. Per AGENTS.md, the *Client* interface is not mocked in
// ledger-touching tests — but the transport boundary inside this package is
// the natural injection seam for unit-testing demux / cache / offset
// invariants.
type Transport interface {
	// Submit issues a non-waiting CommandSubmissionService.Submit.
	Submit(ctx context.Context, req *SubmitRequest) error

	// OpenCompletionStream subscribes to
	// CommandCompletionService.CompletionStream for the given party and
	// resume-offset. The returned channel emits one event per completion
	// record; closing the context closes the stream. Implementations
	// reconnect with backoff internally and surface a fresh channel on
	// each reconnect by closing the previous one cleanly.
	OpenCompletionStream(ctx context.Context, party string, fromOffset string) (<-chan CompletionEvent, error)

	// GetTransactionByID fetches one confirmed transaction via
	// TransactionService.GetTransactions filtered by txID.
	GetTransactionByID(ctx context.Context, txID string) (TransactionDetails, error)

	// Health pings the JSON LAPI /v1/healthz.
	Health(ctx context.Context) error

	// AllocateParty calls the JSON LAPI's idempotent party-allocation
	// helper. Re-allocating an existing party is a no-op.
	AllocateParty(ctx context.Context, hint string) (string, error)

	// ReadMaxDeduplicationDuration is the participant's
	// LedgerConfigurationService / domain-parameters helper (§6.2 boot
	// check (3)). Implementations return ErrMaxDedupUnknown when the
	// participant does not expose the value; the package then applies
	// MaxDeduplicationDurationFallback.
	ReadMaxDeduplicationDuration(ctx context.Context) (time.Duration, error)

	// Close terminates the gRPC connection and any open streams.
	// Idempotent.
	Close() error
}

// ErrMaxDedupUnknown signals that the participant does not advertise its
// maxDeduplicationDuration; callers fall back to
// Config.MaxDeduplicationDurationFallback.
var ErrMaxDedupUnknown = errors.New("canton: maxDeduplicationDuration unavailable")

// ErrTransportNotWired is returned by transport-not-wired stubs (the gRPC
// dialer is owned by Task 9's cmd/server wiring per the dependency graph).
// Production code paths must inject a concrete Transport via NewClient.
var ErrTransportNotWired = errors.New("canton: transport not wired (inject via NewClient)")

// SubmitRequest mirrors the Daml 2.10 com.daml.ledger.api.v1.Commands record.
// Field names are intentionally close to the protobuf field names so the
// Task 9 gRPC wiring is a thin translation.
type SubmitRequest struct {
	CommandID              string
	WorkflowID             string
	ApplicationID          string
	ActAs                  []string
	ReadAs                 []string
	Commands               []Command
	DeadlineDuration       time.Duration
	DeduplicationDuration  time.Duration
	SubmissionID           string // commandId-rotation guard; we set = CommandID.
	LedgerEffectiveTimeMin time.Time
}

// Command is one entry in Commands[]; for SubmitCreateAndExercisePay we emit
// exactly one CreateAndExerciseCommand.
type Command struct {
	Kind                string         // "createAndExercise" for this client.
	TemplateID          string         // e.g. "Payment:PaymentRequest".
	Choice              string         // e.g. "Pay".
	CreateArguments     map[string]any // PaymentRequest fields.
	ChoiceArguments     map[string]any // Pay choice fields (sourceHoldingCid).
	ChoiceTypeName      string         // optional; carried for record-type narrowing.
}

// OffsetStore is the persistence boundary for the ledger-offset checkpoint
// (PLAN.md §6.2 + migration 0004_ledger_offsets.sql). Implementations are
// owned by internal/store; this package consumes the small surface.
type OffsetStore interface {
	GetOffset(ctx context.Context, streamKey string) (offset string, ok bool, err error)
	SaveOffset(ctx context.Context, streamKey string, offset string) error
}

// ---- Client implementation ----------------------------------------------

// client is the concrete Client. It owns the shared stream Manager, the
// inflight-pay semaphore, and a reference to the Transport.
type client struct {
	cfg       Config
	transport Transport
	stream    *Manager
	inflight  chan struct{} // semaphore; cap = cfg.MaxInflightPay.
	closed    chan struct{}
	closeOnce sync.Once
}

// NewClient constructs a Client. It runs the §6.2 boot-time invariants
// (Config.Validate plus the participant's maxDeduplicationDuration probe)
// and starts the shared stream Manager. transport must be non-nil; offsets
// must be a non-nil OffsetStore (or the manager skips checkpointing).
//
// The package level test config_prod_test.go in Task 9 invokes this with the
// full env-derived Config to assert the boot-fast-fail behaviour.
func NewClient(ctx context.Context, cfg Config, transport Transport, offsets OffsetStore) (Client, error) {
	if transport == nil {
		return nil, fmt.Errorf("%w: transport is nil", ErrInvalidConfig)
	}
	// Probe the participant for its maxDeduplicationDuration; if the
	// participant doesn't expose it, fall back to the configured ceiling.
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if cfg.MaxDeduplicationDuration <= 0 {
		dur, err := transport.ReadMaxDeduplicationDuration(probeCtx)
		switch {
		case err == nil:
			cfg.MaxDeduplicationDuration = dur
		case errors.Is(err, ErrMaxDedupUnknown):
			// Fall back to the operator-configured ceiling.
		default:
			return nil, fmt.Errorf("canton: probe maxDeduplicationDuration: %w", err)
		}
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	mgr := NewManager(cfg, transport, offsets)
	if err := mgr.Start(ctx); err != nil {
		return nil, fmt.Errorf("canton: start stream manager: %w", err)
	}
	c := &client{
		cfg:       cfg,
		transport: transport,
		stream:    mgr,
		inflight:  make(chan struct{}, cfg.MaxInflightPay),
		closed:    make(chan struct{}),
	}
	return c, nil
}

// SubmitCreateAndExercisePay builds the gRPC Submit request, registers the
// commandId with the demux BEFORE submitting (per §6.6: register-before-
// submit prevents an early completion racing the waiter), and then drives
// the transport.
//
// The handler in internal/api/signature.go owns the orchestration: it has
// already called store.TransitionAndArmRetry to persist commandId, then
// calls tx_stream.Register(commandID), then this method. RegisterToken is
// not exposed on the Client interface so handlers register through the
// stream Manager directly (see Manager.Register).
func (c *client) SubmitCreateAndExercisePay(ctx context.Context, in CreateAndExercisePayInput) (CreateAndExercisePayOutput, error) {
	if in.OrderID == "" {
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: SubmitCreateAndExercisePay: OrderID required")
	}
	if in.Payer == "" {
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: SubmitCreateAndExercisePay: Payer required")
	}
	// Block under the inflight cap. A handler-side rate limit lives in
	// internal/api/middleware; this is defence-in-depth for sweeper bursts
	// (PLAN.md §6.2 MAX_INFLIGHT_PAY).
	select {
	case c.inflight <- struct{}{}:
	case <-ctx.Done():
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: SubmitCreateAndExercisePay: %w", ctx.Err())
	case <-c.closed:
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: SubmitCreateAndExercisePay: %w", ErrClosed)
	}
	defer func() { <-c.inflight }()

	req, err := NewSubmitRequest(c.cfg, in)
	if err != nil {
		return CreateAndExercisePayOutput{}, err
	}
	// Ensure the demux has an upstream completion stream open for the payer
	// BEFORE we submit. Otherwise Manager.Register's waiter (added by the
	// caller) is orphaned: no goroutine is calling transport.OpenCompletionStream
	// for this party, so the waiter never fires. Idempotent; cheap on the
	// hot path.
	if err := c.stream.EnsurePartyStream(in.Payer); err != nil {
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: ensure party stream: %w", err)
	}
	submittedAt := time.Now().UTC()
	if err := c.transport.Submit(ctx, req); err != nil {
		return CreateAndExercisePayOutput{}, fmt.Errorf("canton: Submit(commandId=%s): %w", req.CommandID, err)
	}
	return CreateAndExercisePayOutput{
		CommandID:   req.CommandID,
		SubmittedAt: submittedAt,
	}, nil
}

// SubscribeCompletions returns the shared demux channel for the given party.
// The handler path registers per-commandId waiters via Manager.Register,
// which is a finer-grained surface than this whole-party stream; this method
// exists for operator tooling and for tests.
func (c *client) SubscribeCompletions(ctx context.Context, partyID string) (<-chan CompletionEvent, error) {
	if partyID == "" {
		return nil, fmt.Errorf("canton: SubscribeCompletions: partyID required")
	}
	return c.stream.SubscribeParty(ctx, partyID)
}

// GetTransactionByID is a thin pass-through to the transport. It is called
// from internal/api/signature.go to construct the receipt from the
// CompletionEvent's TxID.
func (c *client) GetTransactionByID(ctx context.Context, txID string) (TransactionDetails, error) {
	if txID == "" {
		return TransactionDetails{}, fmt.Errorf("canton: GetTransactionByID: txID required")
	}
	return c.transport.GetTransactionByID(ctx, txID)
}

// RecoverByCommandID reads the demux's last-known-event cache (TTL =
// CompletionTTL). The retry path uses this to map a Canton-level
// `ALREADY_EXISTS` / `Aborted (dedup)` to the original commit without
// re-polling the ledger (AGENTS.md forbids ACS polling for completion).
func (c *client) RecoverByCommandID(_ context.Context, commandID string) (CompletionEvent, bool, error) {
	if commandID == "" {
		return CompletionEvent{}, false, fmt.Errorf("canton: RecoverByCommandID: commandID required")
	}
	ev, ok := c.stream.Recover(commandID)
	return ev, ok, nil
}

// Health pings the participant.
func (c *client) Health(ctx context.Context) error {
	return c.transport.Health(ctx)
}

// AllocateParty is a bootstrap-only helper. canton-up.sh calls this once per
// configured payer party; re-runs are no-ops.
func (c *client) AllocateParty(ctx context.Context, hint string) (string, error) {
	return c.transport.AllocateParty(ctx, hint)
}

// Close tears down the demux, flushes the ledger offset, and closes the
// transport. Idempotent.
func (c *client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		close(c.closed)
		if c.stream != nil {
			err = c.stream.Close()
		}
		if c.transport != nil {
			if cerr := c.transport.Close(); cerr != nil && err == nil {
				err = cerr
			}
		}
	})
	return err
}

// ErrClosed signals an operation on an already-closed client.
var ErrClosed = errors.New("canton: client closed")
