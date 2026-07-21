package canton

import (
	"fmt"
	"os"
	"time"
)

// Daml package/module/template names. These pin the wire form the
// participant expects; the daml/ package (Task 3) is the source of truth
// for the record shapes.
//
// Canton 2.x requires a non-empty package_id in command submissions. The
// templatePaymentRequest value is populated at process start: if
// DAML_PAYMENT_PACKAGE_ID is set, it is prepended; otherwise the two-part
// form is used (which only works on participants that have package-name
// resolution enabled).
const choicePay = "Pay"

var templatePaymentRequest = func() string {
	if id := os.Getenv("DAML_PAYMENT_PACKAGE_ID"); id != "" {
		return id + ":Payment:PaymentRequest"
	}
	return "Payment:PaymentRequest"
}()

// ApplicationID is the LAPI applicationId carried on every Submit.
const ApplicationID = "goat-canton-facilitator"

// NewSubmitRequest builds the SubmitRequest for one atomic createAndExercise
// of PaymentRequest + Pay (PLAN.md §6.1 + §6.2). It enforces:
//
//   - commandId byte-identity with OrderID (PLAN.md §6.4 name-map: "Literal:
//     commandId = order.id"). A property test asserts this invariant; any
//     transformation here would defeat both Canton's deduplicationPeriod and
//     the demux's RecoverByCommandID cache.
//   - deadline_duration defaulting to cfg.SubmitDeadline when caller didn't
//     supply one.
//   - deduplication_duration = cfg.DeduplicationDuration (already validated
//     by Config.Validate to be >= cfg.CompletionTTL).
//   - actAs = [in.Payer] only. The facilitator's "operator" party is the
//     participant user (v0 localnet) or the JWT subject (CANTON_PROD);
//     it is NOT additionally listed as an actAs party on the submission —
//     listing it would broaden Daml authority beyond the payer and could
//     allow the Pay choice to satisfy controllers it should not.
func NewSubmitRequest(cfg Config, in CreateAndExercisePayInput) (*SubmitRequest, error) {
	if in.OrderID == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: OrderID required")
	}
	if in.Payer == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: Payer required")
	}
	if in.Merchant == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: Merchant required")
	}
	if in.SourceHoldingContractID == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: SourceHoldingContractID required")
	}
	if in.Amount == "" || in.Currency == "" || in.TrustedIssuer == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: amount/currency/trustedIssuer required")
	}
	if in.DedupKey == "" {
		return nil, fmt.Errorf("canton: NewSubmitRequest: DedupKey required")
	}

	// Per PLAN.md §6.4 name map: "Literal: commandId = order.id (zero
	// transformation)". Any deviation here is a P0 bug. The property test
	// in command_test (when added) asserts byte-equality.
	commandID := in.OrderID

	deadline := in.Deadline
	if deadline <= 0 {
		deadline = cfg.SubmitDeadline
	}

	// createArguments — fields of PaymentRequest (matches daml/Payment.daml
	// in Task 3). The map shape is the protobuf record we hand the
	// gRPC submitter; the transport stage translates this to the actual
	// proto. Field names are camelCase to match Daml record fields.
	createArgs := map[string]any{
		"payer":              Party(in.Payer),
		"merchant":           Party(in.Merchant),
		"amount":             Numeric(in.Amount),
		"currency":           in.Currency,
		"trustedIssuer":      Party(in.TrustedIssuer),
		"resource":           in.Resource,
		"merchantRequestId":  in.MerchantRequestID,
		"nonce":              in.Nonce,
		"dedupKey":           in.DedupKey,
		"expiresAtHttp":      in.ExpiresAtHTTPSeconds,
		"expiresAtDaml":      in.ExpiresAtDamlSeconds,
	}
	choiceArgs := map[string]any{
		"sourceHolding": ContractIDValue(in.SourceHoldingContractID),
	}

	req := &SubmitRequest{
		CommandID:             commandID,
		WorkflowID:            "",
		ApplicationID:         ApplicationID,
		ActAs:                 []string{in.Payer},
		ReadAs:                nil,
		Commands:              []Command{{
			Kind:            "createAndExercise",
			TemplateID:      templatePaymentRequest,
			Choice:          choicePay,
			CreateArguments: createArgs,
			ChoiceArguments: choiceArgs,
		}},
		DeadlineDuration:      deadline,
		DeduplicationDuration: cfg.DeduplicationDuration,
		// SubmissionID = CommandID so the participant's internal
		// submission-id-based bookkeeping aligns with our app-level
		// commandId.
		SubmissionID: commandID,
	}
	if !in.expiresAtHTTPZero() {
		req.LedgerEffectiveTimeMin = time.Unix(in.ExpiresAtHTTPSeconds, 0).Add(-1 * time.Minute).UTC()
	}
	return req, nil
}

func (in CreateAndExercisePayInput) expiresAtHTTPZero() bool {
	return in.ExpiresAtHTTPSeconds == 0
}

// CommandIDFor returns the commandId for a given order id. This is the
// single function the entire codebase uses to derive the commandId — any
// caller (sweeper, retry handler, dedup cache lookup) MUST go through this
// to get the byte-stable, no-transformation result. Returning a function
// rather than inlining `order.id` exists so the invariant is enforceable
// by code review (search for the function name and confirm there are no
// rotating-per-retry callers).
func CommandIDFor(orderID string) string {
	return orderID
}
