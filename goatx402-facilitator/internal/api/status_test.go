package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
)

func TestStatusHandler_HappyPath(t *testing.T) {
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)

	d := api.StatusDeps{
		Store:      st,
		TokenStore: create.TokenStore,
		MaxRetries: 3,
		Now:        create.Now,
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/"+orderID, nil)
	r.Header.Set("X-Payer-Token", token)
	w = httptest.NewRecorder()
	api.StatusHandler(d)(w, r, orderID)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "CREATED" {
		t.Fatalf("status=%v", resp["status"])
	}
	if resp["retryState"] != "healthy" {
		t.Fatalf("retryState=%v", resp["retryState"])
	}
}

func TestStatusHandler_NotFound(t *testing.T) {
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	d := api.StatusDeps{
		Store:      st,
		TokenStore: create.TokenStore,
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/does-not-exist", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.StatusHandler(d)(w, r, "does-not-exist")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestStatusHandler_RequiresToken(t *testing.T) {
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)
	d := api.StatusDeps{Store: st, TokenStore: create.TokenStore}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/"+orderID, nil)
	// no token
	w = httptest.NewRecorder()
	api.StatusHandler(d)(w, r, orderID)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
