package api_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/signer"
)

// memSigner is a minimal signer.Signer for handler tests. It holds an
// in-memory Ed25519 key per party.
type memSigner struct {
	keys map[string]ed25519.PrivateKey
}

func newMemSigner(parties ...string) *memSigner {
	m := &memSigner{keys: map[string]ed25519.PrivateKey{}}
	for _, p := range parties {
		_, priv, _ := ed25519.GenerateKey(rand.Reader)
		m.keys[p] = priv
	}
	return m
}

func (m *memSigner) Sign(_ context.Context, party string, msg []byte) (signer.Signature, error) {
	priv, ok := m.keys[party]
	if !ok {
		return signer.Signature{}, signer.ErrPartyNotFound
	}
	return signer.Signature{Scheme: signer.SchemeEd25519, Bytes: ed25519.Sign(priv, msg)}, nil
}

func (m *memSigner) PublicKey(party string) (ed25519.PublicKey, error) {
	priv, ok := m.keys[party]
	if !ok {
		return nil, signer.ErrPartyNotFound
	}
	return priv.Public().(ed25519.PublicKey), nil
}

// custodialFixture spins up a CustodialSignDeps with one persisted order
// owned by alice.
func custodialFixture(t *testing.T) (api.CustodialSignDeps, *memSigner, string, string) {
	t.Helper()
	st := newTestStore(t)
	d, token := newCreateOrderDeps(t, st)
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(d).ServeHTTP(w, mustReq(token, body))
	if w.Code != http.StatusCreated {
		t.Fatalf("create order: %d body=%s", w.Code, w.Body.String())
	}
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)
	m := newMemSigner("alice")
	deps := api.CustodialSignDeps{
		Store:      st,
		Signer:     m,
		TokenStore: d.TokenStore,
		CantonProd: false,
		Now:        d.Now,
	}
	return deps, m, orderID, token
}

func TestCustodialSign_HappyPath(t *testing.T) {
	deps, _, orderID, token := custodialFixture(t)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders/"+orderID+"/custodial-sign", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CustodialSignHandler(deps)(w, r, orderID)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["signatureScheme"] != "Ed25519" {
		t.Fatalf("scheme=%q", resp["signatureScheme"])
	}
	if _, err := base64.StdEncoding.DecodeString(resp["signature"]); err != nil {
		t.Fatalf("signature not base64: %v", err)
	}
}

func TestCustodialSign_RetiredUnderProd(t *testing.T) {
	deps, _, orderID, token := custodialFixture(t)
	deps.CantonProd = true
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders/"+orderID+"/custodial-sign", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CustodialSignHandler(deps)(w, r, orderID)
	if w.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "ENDPOINT_RETIRED") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestCustodialSign_AuthFailure(t *testing.T) {
	deps, _, orderID, _ := custodialFixture(t)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders/"+orderID+"/custodial-sign", nil)
	w := httptest.NewRecorder()
	api.CustodialSignHandler(deps)(w, r, orderID)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestCustodialSign_OrderNotFound(t *testing.T) {
	deps, _, _, token := custodialFixture(t)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/orders/does-not-exist/custodial-sign", nil)
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.CustodialSignHandler(deps)(w, r, "does-not-exist")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", w.Code, w.Body.String())
	}
}
