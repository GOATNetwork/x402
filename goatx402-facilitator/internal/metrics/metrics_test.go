package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestNew_AllSeriesExposed asserts that every named series from Task 10's
// `/metrics` contract is scrape-visible at zero before any event is observed.
// Pre-initialised label combinations matter: the perf gate triggers off
// per-stage breakdowns, and a missing series during a cold scrape would be
// indistinguishable from "no observations yet".
func TestNew_AllSeriesExposed(t *testing.T) {
	m := New()
	body := scrape(t, m)

	required := []string{
		"facilitator_orders_total",
		"facilitator_order_e2e_latency_seconds",
		"facilitator_stage_latency_seconds",
		"facilitator_skipped_offsets_total",
		"facilitator_demux_restart_loss_total",
		"facilitator_self_verify_failures_total",
		"facilitator_canton_up",
	}
	for _, name := range required {
		if !strings.Contains(body, name) {
			t.Errorf("missing series %q in /metrics output", name)
		}
	}

	// Per-stage histograms must be pre-initialised so scrape consumers see
	// the label set even before the first observation.
	for _, stage := range AllStages() {
		needle := `facilitator_stage_latency_seconds_count{stage="` + stage + `"}`
		if !strings.Contains(body, needle) {
			t.Errorf("missing pre-initialised stage label %q", stage)
		}
	}
}

func TestObserveStage_KnownAndUnknown(t *testing.T) {
	m := New()
	m.ObserveStage(StageHTTPValidate, 0.123)
	m.ObserveStage("not_a_stage", 9.9) // must be a no-op

	body := scrape(t, m)
	if !strings.Contains(body, `facilitator_stage_latency_seconds_count{stage="http_validate"} 1`) {
		t.Errorf("expected http_validate stage count = 1; body:\n%s", body)
	}
	if strings.Contains(body, `stage="not_a_stage"`) {
		t.Error("unknown stage label leaked into /metrics — would explode label cardinality")
	}
}

func TestIncOrderStatus(t *testing.T) {
	m := New()
	m.IncOrderStatus("PAYMENT_CONFIRMED")
	m.IncOrderStatus("PAYMENT_CONFIRMED")
	m.IncOrderStatus("EXPIRED")

	body := scrape(t, m)
	if !strings.Contains(body, `facilitator_orders_total{status="PAYMENT_CONFIRMED"} 2`) {
		t.Errorf("PAYMENT_CONFIRMED count mismatch; body:\n%s", body)
	}
	if !strings.Contains(body, `facilitator_orders_total{status="EXPIRED"} 1`) {
		t.Errorf("EXPIRED count mismatch; body:\n%s", body)
	}
}

func TestSetCantonUp(t *testing.T) {
	m := New()
	m.SetCantonUp(true)
	if !strings.Contains(scrape(t, m), "facilitator_canton_up 1") {
		t.Error("canton_up should be 1 after SetCantonUp(true)")
	}
	m.SetCantonUp(false)
	if !strings.Contains(scrape(t, m), "facilitator_canton_up 0") {
		t.Error("canton_up should be 0 after SetCantonUp(false)")
	}
}

func TestHandler_ServesPrometheusText(t *testing.T) {
	m := New()
	m.SkippedOffsetsTotal.Inc()
	m.DemuxRestartLossTotal.Inc()
	m.DemuxRestartLossTotal.Inc()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200; got %d", w.Code)
	}
	body, _ := io.ReadAll(w.Result().Body)
	if !strings.Contains(string(body), "facilitator_skipped_offsets_total 1") {
		t.Errorf("skipped_offsets_total counter not exposed; body:\n%s", body)
	}
	if !strings.Contains(string(body), "facilitator_demux_restart_loss_total 2") {
		t.Errorf("demux_restart_loss_total counter not exposed; body:\n%s", body)
	}
}

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("scrape returned %d", w.Code)
	}
	body, err := io.ReadAll(w.Result().Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(body)
}
