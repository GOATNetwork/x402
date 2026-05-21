package api

import (
	"net/http"
	"strings"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
)

// RouterDeps bundles every handler dependency. main.go constructs the value
// from internal/config + the wired clients and calls NewRouter once.
type RouterDeps struct {
	CreateOrder      CreateOrderDeps
	CustodialSign    CustodialSignDeps
	Signature        SignatureDeps
	Status           StatusDeps
	Proof            ProofDeps
	DevSourceHolding DevSourceHoldingDeps
	Health           HealthDeps

	CORSOpts        middleware.CORSOptions
	BodyLimit       int64
	RateLimit       middleware.RateLimitOptions
}

// NewRouter wires every route documented in PLAN.md §5.1 + §5.2. The returned
// http.Handler is ready to mount under net/http's Server or to drive from
// tests via httptest.
func NewRouter(d RouterDeps) http.Handler {
	mux := http.NewServeMux()

	// Health probes — no auth, no rate-limit.
	mux.Handle("/healthz", LivenessHandler())
	mux.Handle("/readyz", ReadinessHandler(d.Health))

	// Order endpoints. The order-id paths use a manual splitter because
	// net/http's ServeMux predates Go 1.22 path patterns in the way this
	// project pins go 1.22 — the pattern syntax is supported, but we keep
	// the routing explicit so the per-route middleware composition is
	// auditable.
	orderHandlerChain := composeOrderRouter(d)
	mux.Handle("/api/v1/orders", chain(
		http.HandlerFunc(CreateOrderHandler(d.CreateOrder)),
		middleware.BodyLimit(d.BodyLimit),
		middleware.RequirePayerToken,
		middleware.RateLimit(d.RateLimit),
	))
	mux.Handle("/api/v1/orders/", chain(
		orderHandlerChain,
		middleware.RequirePayerToken,
		middleware.RateLimit(d.RateLimit),
	))

	// dev/source-holding (localnet only — handler enforces the 410 in prod).
	mux.Handle("/api/v1/dev/source-holding", chain(
		DevSourceHoldingHandler(d.DevSourceHolding),
		middleware.RequirePayerToken,
		middleware.RateLimit(d.RateLimit),
	))

	// Wrap the whole mux in CORS so OPTIONS preflight always succeeds first.
	corsMW := middleware.CORS(d.CORSOpts)
	return corsMW(mux)
}

// chain composes middlewares in reverse order so the first argument is the
// outermost wrapper. The handler is the innermost.
func chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// composeOrderRouter handles /api/v1/orders/:id/... — sub-routes are dispatched
// by splitting the remaining path.
func composeOrderRouter(d RouterDeps) http.Handler {
	custodialSign := CustodialSignHandler(d.CustodialSign)
	signature := SignatureHandler(d.Signature)
	status := StatusHandler(d.Status)
	proof := ProofHandler(d.Proof)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/orders/")
		if rest == "" {
			writeError(w, http.StatusNotFound, ErrOrderNotFound, "missing order id")
			return
		}
		segs := strings.SplitN(rest, "/", 2)
		orderID := segs[0]
		if len(segs) == 1 {
			// /api/v1/orders/:id — status endpoint.
			status(w, r, orderID)
			return
		}
		switch segs[1] {
		case "custodial-sign":
			custodialSign(w, r, orderID)
		case "calldata-signature":
			signature(w, r, orderID)
		case "proof":
			proof(w, r, orderID)
		default:
			writeError(w, http.StatusNotFound, ErrOrderNotFound, "unknown order sub-route")
		}
	})
}
