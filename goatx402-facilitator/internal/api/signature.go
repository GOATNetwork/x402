package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/canton"
	"github.com/goatnetwork/goatx402-facilitator/internal/receipt/sign"
	"github.com/goatnetwork/goatx402-facilitator/internal/signer"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
	"github.com/goatnetwork/goatx402-receipt"
)

// CantonOps is the subset of canton operations the signature handler uses.
// We expose it as an interface so unit tests can drop in a deterministic
// fake without standing up gRPC; AGENTS.md forbids mocking *canton.Client*
// for ledger-touching tests, but this seam is the HTTP-handler-side wrapper
// and exists specifically so the api package can be unit-tested.
type CantonOps interface {
	Submit(ctx context.Context, in canton.CreateAndExercisePayInput) (canton.CreateAndExercisePayOutput, error)
	Register(commandID string) (<-chan canton.CompletionEvent, error)
	Recover(commandID string) (canton.CompletionEvent, bool)
	GetTransactionByID(ctx context.Context, txID string) (canton.TransactionDetails, error)
	Unregister(commandID string)
}

// SignatureDeps carries dependencies for POST /:id/calldata-signature.
type SignatureDeps struct {
	Store            store.OrderStore
	Registry         *signer.PayerKeyRegistry
	TokenStore       middleware.PayerTokenStore
	Canton           CantonOps
	Signer           *sign.Signer
	ParticipantParty string
	LedgerID         string
	LedgerSkew       time.Duration
	InitialBackoff   time.Duration
	WaitDefault      time.Duration
	WaitMax          time.Duration
	Now              func() time.Time
	Logger           *slog.Logger
}

type signatureRequest struct {
	SignatureScheme string `json:"signatureScheme"`
	Signature       string `json:"signature"`
	PublicKey       string `json:"publicKey"`
}

type signatureAsyncResponse struct {
	OrderID string `json:"orderId"`
	Status  string `json:"status"`
}

type signatureSyncResponse struct {
	OrderID string                 `json:"orderId"`
	Status  string                 `json:"status"`
	Receipt receipt.CantonReceipt  `json:"receipt"`
}

// SignatureHandler is the POST /api/v1/orders/:id/calldata-signature handler.
// It verifies the payer's Ed25519 signature against the canonical submission
// bytes, transitions to CHECKOUT_VERIFIED via TransitionAndArmRetry, registers
// with the canton demux, submits, and (when ?wait=true) waits for the
// mediator-confirm completion.
func SignatureHandler(d SignatureDeps) func(http.ResponseWriter, *http.Request, string) {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	return func(w http.ResponseWriter, r *http.Request, orderID string) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		var req signatureRequest
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, ErrInvalidInput, "malformed request body")
			return
		}
		if req.SignatureScheme != receipt.SignatureSchemeEd25519 {
			writeError(w, http.StatusBadRequest, ErrInvalidInput, "unsupported signatureScheme")
			return
		}

		o, canonical, err := LoadCanonicalSubmissionFor(r.Context(), d.Store, orderID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErrorWithOrder(w, http.StatusNotFound, ErrOrderNotFound, "order not found", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load order", orderID)
			return
		}

		// Token binding.
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

		if o.Status != store.StatusCreated {
			writeErrorWithOrder(w, http.StatusConflict, ErrInvalidState, "order not in CREATED", orderID)
			return
		}
		if d.Now().UnixMilli() > o.ExpiresAt {
			writeErrorWithOrder(w, http.StatusGone, ErrOrderExpired, "order expired", orderID)
			return
		}

		// Integrity diff (§6.6).
		digest := sha256.Sum256(canonical)
		if !bytes.Equal(digest[:], o.PayloadHash) {
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrIntegrityFailure,
				"payload hash mismatch", orderID)
			return
		}

		// Verify signature against the registry's pubkey for order.payer.
		regPub, err := d.Registry.PublicKey(o.Payer)
		if err != nil {
			writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidSignature,
				"payer not in registry", orderID)
			return
		}
		clientPub, err := base64.StdEncoding.DecodeString(req.PublicKey)
		if err != nil || len(clientPub) != ed25519.PublicKeySize {
			writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidSignature,
				"publicKey malformed", orderID)
			return
		}
		if !bytes.Equal(clientPub, regPub) {
			writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidSignature,
				"publicKey mismatch", orderID)
			return
		}
		sigBytes, err := base64.StdEncoding.DecodeString(req.Signature)
		if err != nil {
			writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidSignature,
				"signature malformed", orderID)
			return
		}
		if !ed25519.Verify(regPub, canonical, sigBytes) {
			writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidSignature,
				"signature verification failed", orderID)
			return
		}

		// Transition + arm retry; reuses order.id as commandId per §6.4.
		commandID := canton.CommandIDFor(o.ID)
		backoff := d.InitialBackoff
		if backoff <= 0 {
			backoff = time.Second
		}
		initialNextAt := d.Now().Add(backoff)
		newOrder, err := d.Store.TransitionAndArmRetry(r.Context(), o.ID, o.StatusVersion, commandID, initialNextAt)
		if err != nil {
			if errors.Is(err, store.ErrCASFailed) {
				writeErrorWithOrder(w, http.StatusConflict, ErrInvalidState,
					"concurrent transition", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal,
				"transition", orderID)
			return
		}

		// Register BEFORE submit.
		ch, err := d.Canton.Register(commandID)
		if err != nil {
			if errors.Is(err, canton.ErrAlreadyRegistered) {
				// Concurrent sweeper retry already owns the slot; attach.
				if ev, ok := d.Canton.Recover(commandID); ok {
					signResolveCompletion(r.Context(), w, d, newOrder, commandID, ev, true)
					return
				}
			}
			writeErrorWithOrder(w, http.StatusServiceUnavailable, ErrLedgerUnavailable,
				"demux register failed", orderID)
			return
		}

		// Build the canton submission input.
		dedupKey := dedupKeyFromCanonical(canonical)
		expiresAtDaml := o.ExpiresAt + d.LedgerSkew.Milliseconds()
		submitIn := canton.CreateAndExercisePayInput{
			OrderID:                 o.ID,
			Payer:                   o.Payer,
			Merchant:                o.Merchant,
			Amount:                  o.Amount,
			Currency:                o.Currency,
			TrustedIssuer:           o.TrustedIssuer,
			SourceHoldingContractID: o.SourceHoldingContractID,
			MerchantRequestID:       o.MerchantRequestID,
			Resource:                o.Resource,
			Nonce:                   o.Nonce,
			DedupKey:                dedupKey,
			ExpiresAtHTTPSeconds:    o.ExpiresAt / 1000,
			ExpiresAtDamlSeconds:    expiresAtDaml / 1000,
		}
		if _, err := d.Canton.Submit(r.Context(), submitIn); err != nil {
			d.Canton.Unregister(commandID)
			// Surface the canonical 5xx — the order stays in CHECKOUT_VERIFIED
			// with retry_next_at armed; the sweeper drives the retry.
			d.Logger.Error("canton submit failed",
				"order_id", orderID, "command_id", commandID, "err_class", "submit",
				"error_detail", err.Error())
			writeErrorWithOrder(w, http.StatusServiceUnavailable, ErrLedgerUnavailable,
				"submit failed", orderID)
			return
		}

		// Parse wait params.
		waitMode, waitTimeout := parseWait(r, d.WaitDefault, d.WaitMax)
		if !waitMode {
			// Async path: spawn one background completer (§6.6 wait=false branch).
			go d.runBackgroundCompleter(commandID, newOrder, ch)
			writeJSON(w, http.StatusAccepted, signatureAsyncResponse{
				OrderID: o.ID,
				Status:  string(store.StatusCheckoutVerified),
			})
			return
		}
		// Sync path: block on the demux.
		select {
		case ev := <-ch:
			signResolveCompletion(r.Context(), w, d, newOrder, commandID, ev, true)
		case <-time.After(waitTimeout):
			// Caller drops; the background completer takes over the demux
			// event whenever it lands.
			go d.runBackgroundCompleter(commandID, newOrder, ch)
			writeJSON(w, http.StatusGatewayTimeout, signatureAsyncResponse{
				OrderID: o.ID,
				Status:  string(store.StatusCheckoutVerified),
			})
		case <-r.Context().Done():
			go d.runBackgroundCompleter(commandID, newOrder, ch)
			writeErrorWithOrder(w, http.StatusServiceUnavailable, ErrLedgerUnavailable,
				"client disconnected", orderID)
		}
	}
}

// runBackgroundCompleter consumes the demux channel and persists the receipt
// or records a retry. It is shared by the wait=false path and the
// wait=true-timeout fallback.
func (d SignatureDeps) runBackgroundCompleter(commandID string, o store.Order, ch <-chan canton.CompletionEvent) {
	ev, ok := <-ch
	if !ok {
		return
	}
	// Use background ctx; the caller may have disconnected.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if ev.Status != canton.CompletionSuccess {
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			ev.Code, ev.Message, time.Now().Add(d.InitialBackoff), o.StatusVersion)
		return
	}
	tx, err := d.Canton.GetTransactionByID(ctx, ev.TxID)
	if err != nil {
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			"LEDGER_ERROR", err.Error(), time.Now().Add(d.InitialBackoff), o.StatusVersion)
		return
	}
	receiptOut, err := d.signReceipt(o, ev, tx)
	if err != nil {
		d.Logger.Error("self-verify failed",
			"order_id", o.ID, "command_id", commandID, "err_class", "self_verify")
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			"SELF_VERIFY_FAILURE", "structural integrity", time.Now().Add(d.InitialBackoff), o.StatusVersion)
		return
	}
	_, _ = d.Store.SaveReceiptAndConfirm(ctx, o.ID, receiptOut, o.StatusVersion)
}

// signResolveCompletion processes a CompletionEvent synchronously and writes
// the appropriate HTTP response. Returns nothing — the response is on w.
func signResolveCompletion(
	ctx context.Context,
	w http.ResponseWriter,
	d SignatureDeps,
	o store.Order,
	commandID string,
	ev canton.CompletionEvent,
	_ bool,
) {
	if ev.Status != canton.CompletionSuccess {
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			ev.Code, ev.Message, time.Now().Add(d.InitialBackoff), o.StatusVersion)
		mapCompletionFailure(w, o.ID, ev)
		return
	}
	tx, err := d.Canton.GetTransactionByID(ctx, ev.TxID)
	if err != nil {
		d.Logger.Error("get transaction failed",
			"order_id", o.ID, "command_id", commandID, "tx_id", ev.TxID,
			"err_class", "fetch_tx", "error_detail", err.Error())
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			"LEDGER_ERROR", err.Error(), time.Now().Add(d.InitialBackoff), o.StatusVersion)
		writeErrorWithOrder(w, http.StatusBadGateway, ErrLedgerError, "fetch tx", o.ID)
		return
	}
	receiptOut, err := d.signReceipt(o, ev, tx)
	if err != nil {
		d.Logger.Error("self-verify failed",
			"order_id", o.ID, "command_id", commandID, "err_class", "self_verify")
		_, _ = d.Store.RecordRetry(ctx, o.ID,
			"SELF_VERIFY_FAILURE", "structural integrity", time.Now().Add(d.InitialBackoff), o.StatusVersion)
		writeErrorWithOrder(w, http.StatusInternalServerError, ErrIntegrityFailure,
			"self verify failed", o.ID)
		return
	}
	if _, err := d.Store.SaveReceiptAndConfirm(ctx, o.ID, receiptOut, o.StatusVersion); err != nil {
		writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal,
			"persist receipt", o.ID)
		return
	}
	writeJSON(w, http.StatusOK, signatureSyncResponse{
		OrderID: o.ID,
		Status:  string(store.StatusPaymentConfirmed),
		Receipt: receiptOut,
	})
}

func mapCompletionFailure(w http.ResponseWriter, orderID string, ev canton.CompletionEvent) {
	// Map gRPC code → HTTP envelope per §6.2.
	switch ev.Code {
	case "INSUFFICIENT_HOLDING":
		writeErrorWithOrder(w, http.StatusBadRequest, ErrInsufficientHolding, "insufficient holding", orderID)
	case "SOURCE_HOLDING_GONE":
		writeErrorWithOrder(w, http.StatusConflict, ErrSourceHoldingGone, "source holding gone", orderID)
	case "INVALID_INPUT":
		writeErrorWithOrder(w, http.StatusBadRequest, ErrInvalidInput, "ledger rejected input", orderID)
	case "DEADLINE_EXCEEDED", "LEDGER_TIMEOUT":
		writeErrorWithOrder(w, http.StatusGatewayTimeout, ErrLedgerTimeout, "ledger timeout", orderID)
	case "UNAVAILABLE":
		writeErrorWithOrder(w, http.StatusServiceUnavailable, ErrLedgerUnavailable, "ledger unavailable", orderID)
	default:
		writeErrorWithOrder(w, http.StatusBadGateway, ErrLedgerError, "ledger error", orderID)
	}
}

// signReceipt builds the canonical receipt from the order + completion event
// and asks the sign.Signer to sign + self-verify it.
func (d SignatureDeps) signReceipt(
	o store.Order,
	ev canton.CompletionEvent,
	tx canton.TransactionDetails,
) (receipt.CantonReceipt, error) {
	if d.Signer == nil {
		return receipt.CantonReceipt{}, errors.New("sign.Signer not wired")
	}
	completedAtMS := ev.Time.UnixMilli()
	if completedAtMS == 0 {
		completedAtMS = time.Now().UTC().UnixMilli()
	}
	draft := receipt.CantonReceipt{
		OrderID:                  o.ID,
		LedgerID:                 d.LedgerID,
		TransactionID:            ev.TxID,
		ContractID:               tx.HoldingContractID,
		PaymentRequestContractID: tx.PaymentRequestContractID,
		ParticipantPartyID:       d.ParticipantParty,
		Merchant:                 o.Merchant,
		Payer:                    o.Payer,
		Amount:                   o.Amount,
		Currency:                 o.Currency,
		TrustedIssuer:            o.TrustedIssuer,
		Resource:                 o.Resource,
		MerchantRequestID:        o.MerchantRequestID,
		ExpiresAtHTTP:            o.ExpiresAt,
		ExpiresAtDaml:            o.ExpiresAt + d.LedgerSkew.Milliseconds(),
		CompletedAt:              completedAtMS,
	}
	return d.Signer.Sign(draft)
}

// parseWait extracts ?wait=true&timeoutMs= from r. Returns (false, 0) when
// not in wait mode.
func parseWait(r *http.Request, def, max time.Duration) (bool, time.Duration) {
	q := r.URL.Query()
	if q.Get("wait") != "true" {
		return false, 0
	}
	t := def
	if v := q.Get("timeoutMs"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			t = time.Duration(n) * time.Millisecond
		}
	}
	if t > max && max > 0 {
		t = max
	}
	return true, t
}

func dedupKeyFromCanonical(canonical []byte) string {
	h := sha256.Sum256(canonical)
	return hex.EncodeToString(h[:])
}

// Compile-time sanity check.
var _ = fmt.Sprintf // fmt is referenced in error formatters above.
