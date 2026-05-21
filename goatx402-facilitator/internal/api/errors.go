// Package api owns the facilitator's HTTP layer. It is the only package that
// imports net/http; handlers translate envelopes ↔ domain calls and never reach
// gRPC or SQL directly (PLAN.md §6.6).
//
// This file holds the canonical "domain error → HTTP status + error code" map
// every handler emits. The wire shape is:
//
//	{"error": "<CODE>", "message": "<human-readable>", "orderId": "...?"}
//
// PLAN.md §5.1 enumerates every code; this file is the single source of truth.
package api

import (
	"encoding/json"
	"net/http"
)

// ErrorCode is the wire-side string. Keep these aligned with PLAN.md §5.1.
type ErrorCode string

const (
	ErrInvalidInput          ErrorCode = "INVALID_INPUT"
	ErrUnauthenticated       ErrorCode = "UNAUTHENTICATED"
	ErrPayerNotBound         ErrorCode = "PAYER_NOT_BOUND"
	ErrOrderNotFound         ErrorCode = "ORDER_NOT_FOUND"
	ErrInvalidState          ErrorCode = "INVALID_STATE"
	ErrNotConfirmed          ErrorCode = "NOT_CONFIRMED"
	ErrDuplicateDedup        ErrorCode = "DUPLICATE_DEDUP"
	ErrDuplicateClientReq    ErrorCode = "DUPLICATE_CLIENT_REQUEST"
	ErrOrderExpired          ErrorCode = "ORDER_EXPIRED"
	ErrEndpointRetired       ErrorCode = "ENDPOINT_RETIRED"
	ErrCustodialUnavailable  ErrorCode = "CUSTODIAL_UNAVAILABLE"
	ErrInvalidSignature      ErrorCode = "INVALID_SIGNATURE"
	ErrInsufficientHolding   ErrorCode = "INSUFFICIENT_HOLDING"
	ErrSourceHoldingGone     ErrorCode = "SOURCE_HOLDING_GONE"
	ErrLedgerUnavailable     ErrorCode = "LEDGER_UNAVAILABLE"
	ErrLedgerTimeout         ErrorCode = "LEDGER_TIMEOUT"
	ErrLedgerError           ErrorCode = "LEDGER_ERROR"
	ErrPayloadTooLarge       ErrorCode = "PAYLOAD_TOO_LARGE"
	ErrRateLimited           ErrorCode = "RATE_LIMITED"
	ErrInflightLimit         ErrorCode = "INFLIGHT_LIMIT"
	ErrIntegrityFailure      ErrorCode = "INTEGRITY_FAILURE"
	ErrUnknownChallenge      ErrorCode = "UNKNOWN_CHALLENGE"
	ErrInternal              ErrorCode = "INTERNAL"
)

// errorBody is the wire shape.
type errorBody struct {
	Error   ErrorCode `json:"error"`
	Message string    `json:"message,omitempty"`
	OrderID string    `json:"orderId,omitempty"`
}

// writeError encodes a deterministic JSON error response. Callers MUST NOT
// echo internal gRPC strings or signatures here; message is for human
// operators only and is redaction-safe (callers strip anything containing
// secrets BEFORE invoking).
func writeError(w http.ResponseWriter, status int, code ErrorCode, message string) {
	writeErrorWithOrder(w, status, code, message, "")
}

func writeErrorWithOrder(w http.ResponseWriter, status int, code ErrorCode, message, orderID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{
		Error:   code,
		Message: message,
		OrderID: orderID,
	})
}

// writeJSON writes a deterministic JSON success response. The encoder sorts
// map[string]any keys naturally; for structs the field order is the source
// definition order.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
