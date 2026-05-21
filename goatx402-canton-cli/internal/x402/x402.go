// Package x402 discovers a 402 Payment Required envelope from a merchant
// and selects the `canton-daml` accepts entry per PLAN.md §5.3.
package x402

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// SchemeCantonDaml is the only accepts.scheme the CLI handles.
const SchemeCantonDaml = "canton-daml"

// Envelope is the parsed 402 body. Unknown fields are ignored so the merchant
// can grow the envelope shape (e.g. add `extensions`) without breaking the CLI.
type Envelope struct {
	X402Version int      `json:"x402Version"`
	Accepts     []Accept `json:"accepts"`
	Error       string   `json:"error"`
}

// Accept mirrors §5.3 accepts[*]. The CLI uses the canton-daml entry; other
// schemes are passed through but never selected.
type Accept struct {
	Scheme            string `json:"scheme"`
	Amount            string `json:"amount"`
	Currency          string `json:"currency"`
	TrustedIssuer     string `json:"trustedIssuer"`
	PayTo             string `json:"payTo"`
	Facilitator       string `json:"facilitator"`
	Resource          string `json:"resource"`
	MerchantRequestID string `json:"merchantRequestId"`
}

// Discover issues a GET against merchantURL+resourcePath, expects a 402, and
// returns the parsed envelope. Any 2xx is a contract violation (the merchant
// should always 402 before payment) and surfaces as an error so the caller
// can decide what to do.
func Discover(ctx context.Context, hc *http.Client, merchantURL, resourcePath string) (Envelope, *http.Response, error) {
	u := strings.TrimRight(merchantURL, "/") + ensureSlash(resourcePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Envelope{}, nil, fmt.Errorf("x402: build request: %w", err)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return Envelope{}, nil, fmt.Errorf("x402: GET %s: %w", u, err)
	}
	if resp.StatusCode != http.StatusPaymentRequired {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return Envelope{}, resp, fmt.Errorf(
			"x402: expected 402 from %s, got %d: %s",
			u, resp.StatusCode, truncate(string(body), 256),
		)
	}
	defer resp.Body.Close()
	var env Envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return Envelope{}, resp, fmt.Errorf("x402: decode 402 body: %w", err)
	}
	return env, resp, nil
}

// SelectCantonDaml returns the first canton-daml accepts entry. Returns an
// error if no canton-daml entry is present.
func SelectCantonDaml(env Envelope) (Accept, error) {
	for _, a := range env.Accepts {
		if a.Scheme == SchemeCantonDaml {
			return a, nil
		}
	}
	return Accept{}, fmt.Errorf("x402: no %q accepts entry in 402 envelope", SchemeCantonDaml)
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
