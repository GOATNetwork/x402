// Package signer is the v0 wrapper around the facilitator's custodial-sign
// endpoint. Per PLAN.md §3.2.4 the CLI signer is a thin POST to
// /api/v1/orders/:id/custodial-sign; F10 swaps it for a local-key signer that
// implements the same shape.
package signer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// HTTPHeaderXPayerToken is the header name the facilitator expects on every
// authenticated endpoint (PLAN.md §5.5). Kept here as a constant so callers
// don't duplicate the literal.
const HTTPHeaderXPayerToken = "X-Payer-Token"

// SignatureResponse mirrors the facilitator response in §5.1
// /custodial-sign.
type SignatureResponse struct {
	SignatureScheme string `json:"signatureScheme"`
	Signature       string `json:"signature"`
	PublicKey       string `json:"publicKey"`
}

// Client wraps an *http.Client plus the facilitator base URL and the bound
// payer token. The same Client is used for the custodial-sign call here and
// (by the flow) for every other facilitator request — all of them attach the
// same X-Payer-Token header (PLAN.md §5.5).
type Client struct {
	HTTPClient     *http.Client
	FacilitatorURL string
	PayerToken     string
}

// CustodialSign POSTs an empty body to
//
//	POST /api/v1/orders/:id/custodial-sign
//
// and returns the facilitator's {signatureScheme, signature, publicKey}.
// Returns ErrFacilitator wrapping the upstream JSON error body on non-200.
func (c *Client) CustodialSign(ctx context.Context, orderID string) (SignatureResponse, error) {
	if c.PayerToken == "" {
		return SignatureResponse{}, ErrMissingPayerToken
	}
	url := fmt.Sprintf("%s/api/v1/orders/%s/custodial-sign", strings.TrimRight(c.FacilitatorURL, "/"), orderID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(nil))
	if err != nil {
		return SignatureResponse{}, fmt.Errorf("signer: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HTTPHeaderXPayerToken, c.PayerToken)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return SignatureResponse{}, fmt.Errorf("signer: POST custodial-sign: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return SignatureResponse{}, &FacilitatorError{
			Op:         "custodial-sign",
			StatusCode: resp.StatusCode,
			Body:       body,
		}
	}
	var out SignatureResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return SignatureResponse{}, fmt.Errorf("signer: decode response: %w", err)
	}
	return out, nil
}

// ErrMissingPayerToken is returned when the caller tries to call the
// facilitator without first configuring a token. Surfaces as the
// MISSING_PAYER_TOKEN exit code at the CLI entrypoint.
var ErrMissingPayerToken = errors.New("MISSING_PAYER_TOKEN")

// FacilitatorError wraps a non-2xx response from the facilitator. The CLI
// surfaces this verbatim (with the body truncated) so operators can map
// 401/403 etc. to the right runbook line.
type FacilitatorError struct {
	Op         string
	StatusCode int
	Body       []byte
}

// Error implements error.
func (e *FacilitatorError) Error() string {
	body := string(e.Body)
	if len(body) > 512 {
		body = body[:512] + "…"
	}
	return fmt.Sprintf("facilitator %s returned %d: %s", e.Op, e.StatusCode, body)
}

// Code returns the parsed error.error field from the facilitator response
// body (empty string if missing or unparseable). Lets the CLI render a
// short diagnostic without re-parsing.
func (e *FacilitatorError) Code() string {
	var doc struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(e.Body, &doc); err != nil {
		return ""
	}
	return doc.Error
}
