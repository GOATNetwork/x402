// Package metrics owns every Prometheus collector exposed by the facilitator
// under `/metrics`. Per PLAN.md §3.7 / Task 10, the public surface is:
//
//   - orders_total{status=...}                      counter
//   - order_e2e_latency_seconds                     histogram (402 → 200)
//   - stage_latency_seconds{stage=...}              histogram, per-stage SLI breakdown
//     stages: http_validate, lapi_submit, mediator_confirm_wait,
//             receipt_sign, merchant_verify
//   - facilitator_skipped_offsets_total             counter (demux skipped offsets)
//   - facilitator_demux_restart_loss_total          counter (events lost on demux restart)
//   - facilitator_self_verify_failures_total        counter (referenced from PLAN §6)
//   - canton_up                                     gauge (1 = healthy, 0 = down)
//
// All collectors live on a dedicated *prometheus.Registry so the /metrics
// endpoint never exposes the process collector's default global state to the
// test binary, and tests can construct an isolated registry trivially.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Stage labels — keep in sync with the §7 Task 10 spec.
const (
	StageHTTPValidate         = "http_validate"
	StageLAPISubmit           = "lapi_submit"
	StageMediatorConfirmWait  = "mediator_confirm_wait"
	StageReceiptSign          = "receipt_sign"
	StageMerchantVerify       = "merchant_verify"
)

// AllStages returns the canonical stage list. Used by tests to assert the
// per-stage histograms are pre-initialised (so `/metrics` scrapes are stable
// across cold starts).
func AllStages() []string {
	return []string{
		StageHTTPValidate,
		StageLAPISubmit,
		StageMediatorConfirmWait,
		StageReceiptSign,
		StageMerchantVerify,
	}
}

// Metrics is the facilitator's collector bundle. Construct exactly one
// instance per process via New(); pass it down to handlers and the
// completion-demux as a dependency.
type Metrics struct {
	registry *prometheus.Registry

	OrdersTotal             *prometheus.CounterVec
	OrderE2ELatency         prometheus.Histogram
	StageLatency            *prometheus.HistogramVec
	SkippedOffsetsTotal     prometheus.Counter
	DemuxRestartLossTotal   prometheus.Counter
	SelfVerifyFailuresTotal prometheus.Counter
	CantonUp                prometheus.Gauge
}

// New constructs the collector bundle and registers everything on a fresh
// registry. The default Go/process collectors are included so operators see
// runtime/GC stats alongside the service-level series.
func New() *Metrics {
	r := prometheus.NewRegistry()

	m := &Metrics{
		registry: r,
		OrdersTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "facilitator_orders_total",
				Help: "Order count partitioned by terminal/transitional status.",
			},
			[]string{"status"},
		),
		OrderE2ELatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "facilitator_order_e2e_latency_seconds",
			Help:    "End-to-end latency from 402 issuance to receipt persistence (the 402→200 round trip the perf gate watches).",
			Buckets: latencyBuckets(),
		}),
		StageLatency: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "facilitator_stage_latency_seconds",
				Help:    "Per-stage latency histograms; the perf gate uses these to localise regressions.",
				Buckets: latencyBuckets(),
			},
			[]string{"stage"},
		),
		SkippedOffsetsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "facilitator_skipped_offsets_total",
			Help: "Number of completion-stream offsets the demux dropped (out-of-order or unmatched command_id).",
		}),
		DemuxRestartLossTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "facilitator_demux_restart_loss_total",
			Help: "Number of completion events lost during a demux restart (estimated from the in-flight registry size).",
		}),
		SelfVerifyFailuresTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "facilitator_self_verify_failures_total",
			Help: "Number of receipt sign-then-verify round trips that the participant-operator signer rejected before persistence.",
		}),
		CantonUp: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "facilitator_canton_up",
			Help: "Canton participant reachability: 1 = healthy, 0 = unreachable.",
		}),
	}

	r.MustRegister(
		m.OrdersTotal,
		m.OrderE2ELatency,
		m.StageLatency,
		m.SkippedOffsetsTotal,
		m.DemuxRestartLossTotal,
		m.SelfVerifyFailuresTotal,
		m.CantonUp,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	// Pre-initialise every label combination so `/metrics` exposes the
	// series at zero before the first event lands. Without this, scrapes
	// during a cold window would silently miss stages.
	for _, status := range knownOrderStatuses() {
		m.OrdersTotal.WithLabelValues(status)
	}
	for _, stage := range AllStages() {
		m.StageLatency.WithLabelValues(stage)
	}

	return m
}

// Registry exposes the underlying registry for tests / advanced scrapers.
func (m *Metrics) Registry() *prometheus.Registry { return m.registry }

// Handler returns an http.Handler that serves `/metrics` against the bundle's
// registry. Mount this on the router under `/metrics`.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{
		Registry: m.registry,
	})
}

// ObserveStage records a per-stage latency observation. The caller must use
// one of the Stage* constants — unknown stages are dropped on the floor (no
// label cardinality explosion).
func (m *Metrics) ObserveStage(stage string, seconds float64) {
	if !isKnownStage(stage) {
		return
	}
	m.StageLatency.WithLabelValues(stage).Observe(seconds)
}

// IncOrderStatus increments the orders_total counter for the given status.
// Unknown statuses are accepted (the order state machine is the source of
// truth — adding a new state shouldn't require a metrics-package change).
func (m *Metrics) IncOrderStatus(status string) {
	m.OrdersTotal.WithLabelValues(status).Inc()
}

// SetCantonUp toggles the canton_up gauge. `true` → 1, `false` → 0.
func (m *Metrics) SetCantonUp(up bool) {
	if up {
		m.CantonUp.Set(1)
		return
	}
	m.CantonUp.Set(0)
}

func isKnownStage(stage string) bool {
	for _, s := range AllStages() {
		if s == stage {
			return true
		}
	}
	return false
}

// knownOrderStatuses mirrors CLAUDE.md §4: CREATED → CHECKOUT_VERIFIED →
// PAYMENT_CONFIRMED | CANCELLED | EXPIRED, plus the implementation's PAYMENT_FAILED.
func knownOrderStatuses() []string {
	return []string{
		"CREATED",
		"CHECKOUT_VERIFIED",
		"PAYMENT_CONFIRMED",
		"PAYMENT_FAILED",
		"CANCELLED",
		"EXPIRED",
	}
}

// latencyBuckets returns the histogram bucket layout shared by the e2e and
// per-stage histograms. The buckets reach to ~10 s because REQUIREMENT §3.7
// caps the perf gate at < 5 s P95 — we want enough resolution around that
// threshold plus tail buckets to spot pathological regressions.
func latencyBuckets() []float64 {
	return []float64{
		0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
		0.5, 1, 2.5, 5, 7.5, 10,
	}
}
