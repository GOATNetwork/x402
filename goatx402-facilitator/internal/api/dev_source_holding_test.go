package api_test

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
)

func devDeps() (api.DevSourceHoldingDeps, string) {
	rawToken := []byte("alice-secret-32bytes-padding-here00")
	store := middleware.MapPayerTokenStore{"alice": rawToken}
	deps := api.DevSourceHoldingDeps{
		FixturePath: "fixture.json",
		TokenStore:  store,
		ReadFile: func(string) ([]byte, error) {
			return []byte(`{"alice":"src-cid-alice"}`), nil
		},
	}
	return deps, base64.StdEncoding.EncodeToString(rawToken)
}

func TestDevSourceHolding_HappyPath(t *testing.T) {
	deps, token := devDeps()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding?payer=alice", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "src-cid-alice") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestDevSourceHolding_NoTokenReturns401(t *testing.T) {
	deps, _ := devDeps()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding?payer=alice", nil)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestDevSourceHolding_WrongTokenReturns403(t *testing.T) {
	deps, _ := devDeps()
	wrong := base64.StdEncoding.EncodeToString([]byte("nope"))
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding?payer=alice", nil)
	r.Header.Set("X-Payer-Token", wrong)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "PAYER_NOT_BOUND") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestDevSourceHolding_RetiredUnderProd(t *testing.T) {
	deps, token := devDeps()
	deps.CantonProd = true
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding?payer=alice", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ENDPOINT_RETIRED") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestDevSourceHolding_MissingPayerParam(t *testing.T) {
	deps, token := devDeps()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDevSourceHolding_FixtureReadError(t *testing.T) {
	deps, token := devDeps()
	deps.ReadFile = func(string) ([]byte, error) { return nil, errors.New("missing") }
	r := httptest.NewRequest(http.MethodGet, "/api/v1/dev/source-holding?payer=alice", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.DevSourceHoldingHandler(deps).ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
}
