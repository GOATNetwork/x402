// Package flow runs the client state machine for one x402 round trip
// (PLAN.md §6.8):
//
//	discover 402 → create order → request signature → submit signature
//	→ wait for PAYMENT_CONFIRMED → fetch proof → replay to merchant.
//
// Every facilitator request carries X-Payer-Token (PLAN.md §5.5); the auth
// binding is centralised on facilitatorRequest below so a future endpoint
// addition cannot accidentally omit it.
package flow

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/goatnetwork/goatx402-canton-cli/internal/holding"
	"github.com/goatnetwork/goatx402-canton-cli/internal/output"
	"github.com/goatnetwork/goatx402-canton-cli/internal/signer"
	"github.com/goatnetwork/goatx402-canton-cli/internal/x402"
	"github.com/goatnetwork/goatx402-receipt"
)

// MissingPayerTokenRunbook is the operator hint emitted alongside the
// MISSING_PAYER_TOKEN exit. It points at the same script PLAN.md §5.5 names
// as the token source of truth.
const MissingPayerTokenRunbook = "run scripts/init-custodial-keys.sh and source ${PAYER_TOKEN_FILE} for this payer"

// MissingSourceHoldingRunbook is the operator hint emitted alongside the
// MISSING_SOURCE_HOLDING exit (PLAN.md §3.2.4 fixture file path).
const MissingSourceHoldingRunbook = "set --source-holding=<cid>, export SOURCE_HOLDING_CID=<cid>, or run scripts/e2e-smoke.sh which writes ${HOME}/.goat-canton/source-holding.json"

// Config is the fully-resolved set of inputs Run consumes. main.go is in
// charge of resolving --payer-token / --source-holding precedence before
// constructing Config; Run never touches env or argv itself.
type Config struct {
	MerchantURL    string
	FacilitatorURL string
	Payer          string
	Amount         string // optional; defaults to merchant 402 amount
	SourceHolding  string
	SourceHoldingOrigin string // "flag" | "env" | "fixture"
	PayerToken     string
	ResourcePath   string

	// X402Version is the wire version the CLI advertises in POST /orders.
	// Defaults to 1.
	X402Version int

	// ExpiresIn is the per-order TTL (seconds). Defaults to 120 per
	// PLAN.md §5.1.
	ExpiresIn int

	// HTTPClient is the underlying transport. Tests inject an
	// httptest-backed client.
	HTTPClient *http.Client

	// Clock is the time source; injectable for deterministic tests.
	Clock func() time.Time

	// PollInterval bounds the long-poll loop for GET /orders/:id. The
	// facilitator supports ?wait=true, but the CLI also polls in case
	// the facilitator does not return synchronously.
	PollInterval time.Duration

	// MaxWait caps the whole order-confirmation wait.
	MaxWait time.Duration
}

// Run executes the round trip. Returns the populated output.Result and a
// non-nil error on any failure. On success the result includes the merchant
// response body and the participant-signed receipt.
func Run(ctx context.Context, cfg Config) (output.Result, error) {
	if err := validateConfig(cfg); err != nil {
		return errResult(err), err
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}

	res := output.Result{
		Outcome: "ok",
		SourceHolding: &output.SourceHoldingInfo{
			ContractID: cfg.SourceHolding,
			Source:     cfg.SourceHoldingOrigin,
		},
	}

	// 1. Discover 402.
	env, _, err := x402.Discover(ctx, hc, cfg.MerchantURL, cfg.ResourcePath)
	if err != nil {
		return errResult(err), err
	}
	accept, err := x402.SelectCantonDaml(env)
	if err != nil {
		return errResult(err), err
	}
	if accept.Facilitator != "" && cfg.FacilitatorURL == "" {
		cfg.FacilitatorURL = accept.Facilitator
	}
	if cfg.Amount == "" {
		cfg.Amount = accept.Amount
	}
	res.MerchantRequestID = accept.MerchantRequestID

	// 2. POST /api/v1/orders.
	orderResp, err := createOrder(ctx, hc, cfg, accept)
	if err != nil {
		return errResult(err), err
	}
	res.OrderID = orderResp.OrderID

	// 3. POST /api/v1/orders/:id/custodial-sign.
	sigClient := &signer.Client{
		HTTPClient:     hc,
		FacilitatorURL: cfg.FacilitatorURL,
		PayerToken:     cfg.PayerToken,
	}
	sigResp, err := sigClient.CustodialSign(ctx, orderResp.OrderID)
	if err != nil {
		return errResult(err), err
	}

	// 4. POST /api/v1/orders/:id/calldata-signature?wait=true.
	rcpt, terminal, err := submitSignature(ctx, hc, cfg, orderResp.OrderID, sigResp)
	if err != nil {
		return errResult(err), err
	}

	// 5. If the facilitator returned 202 we fall back to polling
	//    GET /api/v1/orders/:id (with ?wait=true) until terminal.
	if !terminal {
		if err := waitForConfirmation(ctx, hc, cfg, orderResp.OrderID); err != nil {
			return errResult(err), err
		}
	}

	// 6. GET /api/v1/orders/:id/proof.
	if rcpt == nil {
		fetched, err := fetchProof(ctx, hc, cfg, orderResp.OrderID)
		if err != nil {
			return errResult(err), err
		}
		rcpt = &fetched
	}
	res.Receipt = rcpt

	// 7. Replay to merchant.
	body, err := replayToMerchant(ctx, hc, cfg, *rcpt)
	if err != nil {
		return errResult(err), err
	}
	res.ResponseBody = body
	return res, nil
}

func validateConfig(cfg Config) error {
	if cfg.MerchantURL == "" {
		return errors.New("merchant URL required")
	}
	if cfg.Payer == "" {
		return errors.New("payer required")
	}
	if cfg.PayerToken == "" {
		return errors.New("MISSING_PAYER_TOKEN")
	}
	if cfg.SourceHolding == "" {
		return errors.New("MISSING_SOURCE_HOLDING")
	}
	return nil
}

// errResult is a small helper that builds an output.Result for a failed run.
// It chooses a runbook based on the error message (MISSING_PAYER_TOKEN /
// MISSING_SOURCE_HOLDING) so a JSON consumer gets a stable Runbook field.
func errResult(err error) output.Result {
	r := output.Result{
		Outcome:      classifyOutcome(err),
		ErrorMessage: err.Error(),
	}
	switch r.Outcome {
	case "MISSING_PAYER_TOKEN":
		r.Runbook = MissingPayerTokenRunbook
	case "MISSING_SOURCE_HOLDING":
		r.Runbook = MissingSourceHoldingRunbook
	}
	return r
}

func classifyOutcome(err error) string {
	if err == nil {
		return "ok"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "MISSING_PAYER_TOKEN"),
		errors.Is(err, signer.ErrMissingPayerToken):
		return "MISSING_PAYER_TOKEN"
	case strings.Contains(msg, "MISSING_SOURCE_HOLDING"),
		errors.Is(err, holding.ErrMissing):
		return "MISSING_SOURCE_HOLDING"
	}
	// Surface the facilitator error code in the outcome when present so a
	// JSON consumer can branch on it.
	var fe *signer.FacilitatorError
	if errors.As(err, &fe) {
		if c := fe.Code(); c != "" {
			return c
		}
	}
	return "ERROR"
}

// createOrderRequest mirrors POST /api/v1/orders body (PLAN.md §5.1).
type createOrderRequest struct {
	X402Version             int    `json:"x402Version"`
	Merchant                string `json:"merchant"`
	Payer                   string `json:"payer"`
	Amount                  string `json:"amount"`
	Currency                string `json:"currency"`
	TrustedIssuer           string `json:"trustedIssuer"`
	Resource                string `json:"resource"`
	MerchantRequestID       string `json:"merchantRequestId"`
	SourceHoldingContractID string `json:"sourceHoldingContractId"`
	ExpiresIn               int    `json:"expiresIn,omitempty"`
}

// createOrderResponse mirrors §5.1 201 envelope (the subset we read).
type createOrderResponse struct {
	X402Version           int    `json:"x402Version"`
	OrderID               string `json:"orderId"`
	Nonce                 string `json:"nonce"`
	Status                string `json:"status"`
	SubmissionPayloadHash string `json:"submissionPayloadHash"`
}

func createOrder(ctx context.Context, hc *http.Client, cfg Config, a x402.Accept) (createOrderResponse, error) {
	body := createOrderRequest{
		X402Version:             nonZero(cfg.X402Version, 1),
		Merchant:                a.PayTo,
		Payer:                   cfg.Payer,
		Amount:                  cfg.Amount,
		Currency:                a.Currency,
		TrustedIssuer:           a.TrustedIssuer,
		Resource:                a.Resource,
		MerchantRequestID:       a.MerchantRequestID,
		SourceHoldingContractID: cfg.SourceHolding,
		ExpiresIn:               cfg.ExpiresIn,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return createOrderResponse{}, fmt.Errorf("flow: marshal create-order: %w", err)
	}
	url := strings.TrimRight(cfg.FacilitatorURL, "/") + "/api/v1/orders"
	respBody, err := doFacilitatorJSON(ctx, hc, http.MethodPost, url, cfg.PayerToken, raw, http.StatusCreated, "create-order")
	if err != nil {
		return createOrderResponse{}, err
	}
	var out createOrderResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return createOrderResponse{}, fmt.Errorf("flow: decode create-order: %w", err)
	}
	return out, nil
}

// signatureRequest mirrors §5.1 POST /:id/calldata-signature body.
type signatureRequest struct {
	SignatureScheme string `json:"signatureScheme"`
	Signature       string `json:"signature"`
	PublicKey       string `json:"publicKey"`
}

func submitSignature(ctx context.Context, hc *http.Client, cfg Config, orderID string, sig signer.SignatureResponse) (*receipt.CantonReceipt, bool, error) {
	body, err := json.Marshal(signatureRequest{
		SignatureScheme: sig.SignatureScheme,
		Signature:       sig.Signature,
		PublicKey:       sig.PublicKey,
	})
	if err != nil {
		return nil, false, fmt.Errorf("flow: marshal signature: %w", err)
	}
	url := fmt.Sprintf("%s/api/v1/orders/%s/calldata-signature?wait=true&timeoutMs=%d",
		strings.TrimRight(cfg.FacilitatorURL, "/"), orderID, int64(cfg.MaxWait/time.Millisecond))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("flow: build signature request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(signer.HTTPHeaderXPayerToken, cfg.PayerToken)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("flow: POST signature: %w", err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
		var doc struct {
			OrderID string                `json:"orderId"`
			Status  string                `json:"status"`
			Receipt receipt.CantonReceipt `json:"receipt"`
		}
		if err := json.Unmarshal(rb, &doc); err != nil {
			return nil, false, fmt.Errorf("flow: decode sync signature: %w", err)
		}
		return &doc.Receipt, true, nil
	case http.StatusAccepted, http.StatusGatewayTimeout:
		// Async — caller polls.
		return nil, false, nil
	default:
		return nil, false, &signer.FacilitatorError{
			Op:         "calldata-signature",
			StatusCode: resp.StatusCode,
			Body:       rb,
		}
	}
}

// statusResponse mirrors §5.1 GET /:id (only the fields the CLI reads).
type statusResponse struct {
	OrderID    string  `json:"orderId"`
	Status     string  `json:"status"`
	RetryState string  `json:"retryState"`
	RetryLast  *string `json:"retryLastError"`
}

func waitForConfirmation(ctx context.Context, hc *http.Client, cfg Config, orderID string) error {
	deadline := cfg.Clock().Add(cfg.MaxWait)
	for {
		base := strings.TrimRight(cfg.FacilitatorURL, "/")
		url := fmt.Sprintf("%s/api/v1/orders/%s?wait=true&timeoutMs=%d",
			base, orderID, int64(cfg.PollInterval/time.Millisecond)*2)
		rb, err := doFacilitatorJSON(ctx, hc, http.MethodGet, url, cfg.PayerToken, nil, http.StatusOK, "status")
		if err != nil {
			return err
		}
		var s statusResponse
		if err := json.Unmarshal(rb, &s); err != nil {
			return fmt.Errorf("flow: decode status: %w", err)
		}
		switch s.Status {
		case "PAYMENT_CONFIRMED":
			return nil
		case "PAYMENT_FAILED", "EXPIRED", "CANCELLED":
			detail := ""
			if s.RetryLast != nil {
				detail = *s.RetryLast
			}
			return fmt.Errorf("flow: order %s ended in %s (%s)", orderID, s.Status, detail)
		}
		if !cfg.Clock().Before(deadline) {
			return fmt.Errorf("flow: timed out waiting for order %s; last status %s", orderID, s.Status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(cfg.PollInterval):
		}
	}
}

func fetchProof(ctx context.Context, hc *http.Client, cfg Config, orderID string) (receipt.CantonReceipt, error) {
	base := strings.TrimRight(cfg.FacilitatorURL, "/")
	url := fmt.Sprintf("%s/api/v1/orders/%s/proof", base, orderID)
	rb, err := doFacilitatorJSON(ctx, hc, http.MethodGet, url, cfg.PayerToken, nil, http.StatusOK, "proof")
	if err != nil {
		return receipt.CantonReceipt{}, err
	}
	var out receipt.CantonReceipt
	if err := json.Unmarshal(rb, &out); err != nil {
		return receipt.CantonReceipt{}, fmt.Errorf("flow: decode proof: %w", err)
	}
	return out, nil
}

func replayToMerchant(ctx context.Context, hc *http.Client, cfg Config, rcpt receipt.CantonReceipt) (string, error) {
	raw, err := json.Marshal(rcpt)
	if err != nil {
		return "", fmt.Errorf("flow: marshal receipt: %w", err)
	}
	header := base64.StdEncoding.EncodeToString(raw)
	url := strings.TrimRight(cfg.MerchantURL, "/") + ensureSlash(cfg.ResourcePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("flow: build merchant replay: %w", err)
	}
	req.Header.Set("X-PAYMENT", header)
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("flow: GET merchant: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("flow: merchant returned %d on replay: %s",
			resp.StatusCode, truncate(string(body), 256))
	}
	return string(body), nil
}

// doFacilitatorJSON is the single seam that issues authenticated requests at
// the facilitator. Every facilitator request — order create, custodial-sign,
// calldata-signature, status, proof, dev/source-holding — flows through this
// function so the X-Payer-Token header binding is enforced in one place
// (PLAN.md §5.5).
func doFacilitatorJSON(
	ctx context.Context,
	hc *http.Client,
	method, url, token string,
	body []byte,
	wantStatus int,
	op string,
) ([]byte, error) {
	if token == "" {
		return nil, signer.ErrMissingPayerToken
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return nil, fmt.Errorf("flow: build %s: %w", op, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(signer.HTTPHeaderXPayerToken, token)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("flow: %s: %w", op, err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		return nil, &signer.FacilitatorError{
			Op:         op,
			StatusCode: resp.StatusCode,
			Body:       rb,
		}
	}
	return rb, nil
}

func nonZero(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func ensureSlash(p string) string {
	if p == "" {
		return "/"
	}
	if strings.HasPrefix(p, "/") {
		return p
	}
	return "/" + p
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
