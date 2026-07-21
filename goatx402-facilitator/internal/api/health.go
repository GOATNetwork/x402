package api

import (
	"context"
	"net/http"
)

// HealthDeps wires liveness + readiness probes.
type HealthDeps struct {
	// CantonHealth pings the canton participant; pass canton.Client.Health.
	CantonHealth func(ctx context.Context) error
	// StorePing returns nil when the store responds. Pass *sql.DB.PingContext
	// or equivalent.
	StorePing func(ctx context.Context) error
}

// LivenessHandler returns GET /healthz: just confirm the process is up.
func LivenessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}
}

// ReadinessHandler returns GET /readyz: canton.Health() + store.Ping().
func ReadinessHandler(d HealthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.StorePing != nil {
			if err := d.StorePing(r.Context()); err != nil {
				writeError(w, http.StatusServiceUnavailable, ErrLedgerUnavailable, "store ping failed")
				return
			}
		}
		if d.CantonHealth != nil {
			if err := d.CantonHealth(r.Context()); err != nil {
				writeError(w, http.StatusServiceUnavailable, ErrLedgerUnavailable, "canton ping failed")
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	}
}
