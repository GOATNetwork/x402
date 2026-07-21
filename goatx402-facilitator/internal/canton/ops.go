package canton

// ops.go exposes a small adapter that satisfies the api package's CantonOps
// interface (internal/api/signature.go). It exists so cmd/server can wire
// one canton.Client and hand the api.SignatureHandler a value with the four
// methods it needs (Submit / Register / Recover / GetTransactionByID /
// Unregister) without any other facilitator package having to know about
// the demux Manager.
//
// AGENTS.md forbids mocking the canton.Client interface in ledger-touching
// tests; CantonOps is the *handler*-side seam (a different mocking surface)
// and api/signature_test.go injects an in-memory fake against it. This
// adapter is the production binding.

import (
	"context"
	"fmt"
)

// Ops is the production CantonOps adapter. It is a thin pass-through to the
// underlying canton.Client (Submit / GetTransactionByID) and the demux
// Manager (Register / Recover / Unregister).
type Ops struct {
	client *client
}

// NewOps wraps a canton.Client returned by NewClient. It returns an error
// when the Client is not the package's own concrete type (which can only
// happen if someone substitutes a custom Client; the Ops adapter needs
// access to the demux Manager and only the package's *client carries it).
func NewOps(c Client) (*Ops, error) {
	cc, ok := c.(*client)
	if !ok {
		return nil, fmt.Errorf("canton: NewOps: unsupported Client type %T (want package *client from NewClient)", c)
	}
	return &Ops{client: cc}, nil
}

// Submit forwards to canton.Client.SubmitCreateAndExercisePay.
func (o *Ops) Submit(ctx context.Context, in CreateAndExercisePayInput) (CreateAndExercisePayOutput, error) {
	return o.client.SubmitCreateAndExercisePay(ctx, in)
}

// Register reserves a one-shot waiter for the demux. Per PLAN.md §6.6 the
// handler calls Register BEFORE Submit so an early completion cannot race
// the listener. Duplicate registration returns ErrAlreadyRegistered.
func (o *Ops) Register(commandID string) (<-chan CompletionEvent, error) {
	return o.client.stream.Register(commandID)
}

// Recover reads the demux's last-known event cache. Used by the retry path
// (PLAN.md §6.2 "Aborted (dedup) on retry") so a retry that races a
// successful original submission can pick up the original commit without
// re-polling the ledger (AGENTS.md forbids ACS polling for completion).
func (o *Ops) Recover(commandID string) (CompletionEvent, bool) {
	return o.client.stream.Recover(commandID)
}

// GetTransactionByID forwards to canton.Client.GetTransactionByID.
func (o *Ops) GetTransactionByID(ctx context.Context, txID string) (TransactionDetails, error) {
	return o.client.GetTransactionByID(ctx, txID)
}

// Unregister releases a waiter without consuming an event. Used when Submit
// itself fails before any completion can land.
func (o *Ops) Unregister(commandID string) {
	o.client.stream.Unregister(commandID)
}
