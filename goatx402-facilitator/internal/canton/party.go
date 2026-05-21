package canton

import (
	"context"
	"fmt"
	"regexp"
)

// PartyHintPattern bounds the characters operators may pass to
// AllocateParty. It is intentionally narrow (LAPI accepts a wider character
// set, but a hint is operator-controlled and we'd rather reject early than
// surface a participant-side error after a round-trip).
//
// Allowed: letters, digits, `-`, `_`, `.`, length 1..255.
var partyHintPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)

// ValidatePartyHint enforces the documented hint shape. Exposed so callers
// (canton-up.sh wrapper, integration tests) can validate before dialling.
func ValidatePartyHint(hint string) error {
	if !partyHintPattern.MatchString(hint) {
		return fmt.Errorf("canton: party hint %q is not [A-Za-z0-9._-]{1,255}", hint)
	}
	return nil
}

// AllocatePartyOptions reserved for future fields (display name, identity
// provider id, etc.); kept as a struct so callers don't have to change
// their call sites when the surface grows.
type AllocatePartyOptions struct {
	DisplayName        string
	IdentityProviderID string
}

// AllocatePartyWith is the lower-level helper Task 9 wiring can call
// directly when it needs to pass display-name or identity-provider fields.
// Most callers should use Client.AllocateParty (which validates the hint
// and forwards to the transport with empty options).
//
// Idempotency: per Daml LAPI semantics, re-allocating the same party hint
// returns the existing party id without error. The integration test in
// client_integration_test.go covers this.
func AllocatePartyWith(ctx context.Context, t Transport, hint string, _ AllocatePartyOptions) (string, error) {
	if err := ValidatePartyHint(hint); err != nil {
		return "", err
	}
	if t == nil {
		return "", fmt.Errorf("canton: AllocateParty: transport is nil")
	}
	return t.AllocateParty(ctx, hint)
}
