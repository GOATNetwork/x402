package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
)

// StatusDeps carries dependencies for GET /:id.
type StatusDeps struct {
	Store          store.OrderStore
	TokenStore     middleware.PayerTokenStore
	MaxRetries     int
	WaitDefault    time.Duration
	WaitMax        time.Duration
	PollInterval   time.Duration
	Now            func() time.Time
}

type statusResponse struct {
	OrderID        string  `json:"orderId"`
	Status         string  `json:"status"`
	ExpiresAt      int64   `json:"expiresAt"`
	UpdatedAt      int64   `json:"updatedAt"`
	RetryState     string  `json:"retryState"`
	RetryLastError *string `json:"retryLastError"`
}

// StatusHandler returns the GET /api/v1/orders/:id handler.
func StatusHandler(d StatusDeps) func(http.ResponseWriter, *http.Request, string) {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.PollInterval <= 0 {
		d.PollInterval = 100 * time.Millisecond
	}
	return func(w http.ResponseWriter, r *http.Request, orderID string) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		o, err := d.Store.Get(r.Context(), orderID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErrorWithOrder(w, http.StatusNotFound, ErrOrderNotFound, "order not found", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load order", orderID)
			return
		}
		tok := r.Header.Get(middleware.HeaderXPayerToken)
		ok, code := middleware.AssertBoundToParty(tok, o.Payer, d.TokenStore)
		if !ok {
			status := http.StatusUnauthorized
			ec := ErrUnauthenticated
			if code == "PAYER_NOT_BOUND" {
				status = http.StatusForbidden
				ec = ErrPayerNotBound
			}
			writeErrorWithOrder(w, status, ec, "X-Payer-Token check failed", orderID)
			return
		}

		// Optional ?wait=true blocks until a terminal state or timeout.
		waitMode, timeout := parseWait(r, d.WaitDefault, d.WaitMax)
		if waitMode && !isTerminal(o.Status) {
			deadline := d.Now().Add(timeout)
			for d.Now().Before(deadline) {
				time.Sleep(d.PollInterval)
				if r.Context().Err() != nil {
					break
				}
				next, err := d.Store.Get(r.Context(), orderID)
				if err == nil {
					o = next
					if isTerminal(o.Status) {
						break
					}
				}
			}
		}
		writeJSON(w, http.StatusOK, projectStatus(o, d.MaxRetries))
	}
}

func projectStatus(o store.Order, maxRetries int) statusResponse {
	retryState := "healthy"
	switch {
	case o.RetryCount == 0:
		retryState = "healthy"
	case maxRetries > 0 && o.RetryCount >= int64(maxRetries):
		retryState = "exhausted"
	default:
		retryState = "retrying"
	}
	var lastErr *string
	if o.RetryLastError != nil {
		mapped := projectRetryLastError(*o.RetryLastError)
		lastErr = &mapped
	}
	return statusResponse{
		OrderID:        o.ID,
		Status:         string(o.Status),
		ExpiresAt:      o.ExpiresAt,
		UpdatedAt:      o.UpdatedAt,
		RetryState:     retryState,
		RetryLastError: lastErr,
	}
}

// projectRetryLastError maps the raw `code: message` text RecordRetry stored
// into the enumerated set §5.1 documents. Anything else maps to LEDGER_ERROR
// — we never echo the raw gRPC message, which can carry party ids.
func projectRetryLastError(s string) string {
	known := []string{
		"INSUFFICIENT_HOLDING",
		"INVALID_INPUT",
		"SOURCE_HOLDING_GONE",
		"LEDGER_TIMEOUT",
		"LEDGER_UNAVAILABLE",
		"INTEGRITY_FAILURE",
		"SELF_VERIFY_FAILURE",
	}
	for _, k := range known {
		if hasPrefix(s, k) {
			return k
		}
	}
	return "LEDGER_ERROR"
}

func hasPrefix(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	return s[:len(prefix)] == prefix
}

func isTerminal(s store.Status) bool {
	switch s {
	case store.StatusPaymentConfirmed, store.StatusPaymentFailed, store.StatusCancelled, store.StatusExpired:
		return true
	}
	return false
}
