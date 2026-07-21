package api_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/canton"
	"github.com/goatnetwork/goatx402-facilitator/internal/receipt/sign"
	"github.com/goatnetwork/goatx402-facilitator/internal/signer"
)

// fakeCanton satisfies api.CantonOps with deterministic, in-memory behaviour.
type fakeCanton struct {
	mu        sync.Mutex
	pending   map[string]chan canton.CompletionEvent
	completed map[string]canton.CompletionEvent
	// SubmitErr lets tests force a Submit failure.
	SubmitErr error
	// AutoCompleteWith fires a synthetic completion immediately on Submit.
	AutoCompleteWith *canton.CompletionEvent
	// TxByID is the GetTransactionByID fixture.
	TxByID canton.TransactionDetails
}

func newFakeCanton() *fakeCanton {
	return &fakeCanton{
		pending:   map[string]chan canton.CompletionEvent{},
		completed: map[string]canton.CompletionEvent{},
	}
}

func (f *fakeCanton) Submit(_ context.Context, in canton.CreateAndExercisePayInput) (canton.CreateAndExercisePayOutput, error) {
	if f.SubmitErr != nil {
		return canton.CreateAndExercisePayOutput{}, f.SubmitErr
	}
	if f.AutoCompleteWith != nil {
		f.mu.Lock()
		ch, ok := f.pending[in.OrderID]
		f.mu.Unlock()
		if ok {
			ev := *f.AutoCompleteWith
			ev.CommandID = in.OrderID
			f.complete(in.OrderID, ev, ch)
		}
	}
	return canton.CreateAndExercisePayOutput{CommandID: in.OrderID, SubmittedAt: time.Now()}, nil
}

func (f *fakeCanton) Register(commandID string) (<-chan canton.CompletionEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.pending[commandID]; exists {
		return nil, canton.ErrAlreadyRegistered
	}
	ch := make(chan canton.CompletionEvent, 1)
	f.pending[commandID] = ch
	return ch, nil
}

func (f *fakeCanton) Recover(commandID string) (canton.CompletionEvent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ev, ok := f.completed[commandID]
	return ev, ok
}

func (f *fakeCanton) GetTransactionByID(_ context.Context, txID string) (canton.TransactionDetails, error) {
	td := f.TxByID
	td.TxID = txID
	return td, nil
}

func (f *fakeCanton) Unregister(commandID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ch, ok := f.pending[commandID]; ok {
		close(ch)
		delete(f.pending, commandID)
	}
}

// complete pushes a CompletionEvent and caches it.
func (f *fakeCanton) complete(commandID string, ev canton.CompletionEvent, ch chan canton.CompletionEvent) {
	f.mu.Lock()
	f.completed[commandID] = ev
	delete(f.pending, commandID)
	f.mu.Unlock()
	select {
	case ch <- ev:
	default:
	}
	close(ch)
}

func setupSignatureFixture(t *testing.T) (api.SignatureDeps, api.CreateOrderDeps, *fakeCanton, string, string, ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	st := newTestStore(t)
	create, token := newCreateOrderDeps(t, st)

	// Generate alice's keypair and persist as a registry file.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gen alice key: %v", err)
	}
	dir := t.TempDir()
	regPath := filepath.Join(dir, "registry.json")
	regBytes, _ := json.Marshal(map[string]string{
		"alice": base64.StdEncoding.EncodeToString(pub),
	})
	if err := os.WriteFile(regPath, regBytes, 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	registry, err := signer.NewPayerKeyRegistry(regPath)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}

	// Participant-operator signer.
	opPub, opPriv, _ := ed25519.GenerateKey(rand.Reader)
	rsigner, err := sign.NewSigner(sign.SignerOptions{
		PrivateKey: opPriv,
		PublicKey:  opPub,
	})
	if err != nil {
		t.Fatalf("sign.NewSigner: %v", err)
	}

	fc := newFakeCanton()
	deps := api.SignatureDeps{
		Store:            st,
		Registry:         registry,
		TokenStore:       create.TokenStore,
		Canton:           fc,
		Signer:           rsigner,
		ParticipantParty: "participant-operator",
		LedgerID:         "participant1",
		LedgerSkew:       30 * time.Second,
		InitialBackoff:   100 * time.Millisecond,
		WaitDefault:      2 * time.Second,
		WaitMax:          5 * time.Second,
		Now:              create.Now,
	}
	// Create the order to drive against.
	body, _ := json.Marshal(validBody())
	w := httptest.NewRecorder()
	api.CreateOrderHandler(create).ServeHTTP(w, mustReq(token, body))
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	orderID := created["orderId"].(string)
	return deps, create, fc, token, orderID, priv, pub
}

func TestSignature_HappyPathAsync(t *testing.T) {
	deps, _, fc, token, orderID, priv, pub := setupSignatureFixture(t)

	_, canonical, err := api.LoadCanonicalSubmissionFor(context.Background(), deps.Store, orderID)
	if err != nil {
		t.Fatalf("load canonical: %v", err)
	}
	sig := ed25519.Sign(priv, canonical)
	body, _ := json.Marshal(map[string]string{
		"signatureScheme": "Ed25519",
		"signature":       base64.StdEncoding.EncodeToString(sig),
		"publicKey":       base64.StdEncoding.EncodeToString(pub),
	})
	r := httptest.NewRequest(http.MethodPost,
		"/api/v1/orders/"+orderID+"/calldata-signature",
		strings.NewReader(string(body)))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.SignatureHandler(deps)(w, r, orderID)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "CHECKOUT_VERIFIED") {
		t.Fatalf("body=%s", w.Body.String())
	}
	// Cleanup pending demux channel for fakeCanton.
	fc.Unregister(orderID)
}

func TestSignature_BadSignature(t *testing.T) {
	deps, _, _, token, orderID, _, pub := setupSignatureFixture(t)
	// Wrong signature bytes (length-correct but random).
	bad := make([]byte, ed25519.SignatureSize)
	rand.Read(bad)
	body, _ := json.Marshal(map[string]string{
		"signatureScheme": "Ed25519",
		"signature":       base64.StdEncoding.EncodeToString(bad),
		"publicKey":       base64.StdEncoding.EncodeToString(pub),
	})
	r := httptest.NewRequest(http.MethodPost,
		"/api/v1/orders/"+orderID+"/calldata-signature",
		strings.NewReader(string(body)))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.SignatureHandler(deps)(w, r, orderID)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "INVALID_SIGNATURE") {
		t.Fatalf("body=%s", w.Body.String())
	}
}

func TestSignature_PubKeyMismatch(t *testing.T) {
	deps, _, _, token, orderID, priv, _ := setupSignatureFixture(t)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, canonical, _ := api.LoadCanonicalSubmissionFor(context.Background(), deps.Store, orderID)
	sig := ed25519.Sign(priv, canonical)
	body, _ := json.Marshal(map[string]string{
		"signatureScheme": "Ed25519",
		"signature":       base64.StdEncoding.EncodeToString(sig),
		"publicKey":       base64.StdEncoding.EncodeToString(otherPub),
	})
	r := httptest.NewRequest(http.MethodPost,
		"/api/v1/orders/"+orderID+"/calldata-signature",
		strings.NewReader(string(body)))
	r.Header.Set("X-Payer-Token", token)
	w := httptest.NewRecorder()
	api.SignatureHandler(deps)(w, r, orderID)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "INVALID_SIGNATURE") {
		t.Fatalf("body=%s", w.Body.String())
	}
}
