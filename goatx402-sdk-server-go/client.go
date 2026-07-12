package goatx402

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client is the GoatX402 API client for server-side usage
type Client struct {
	config     Config
	httpClient *http.Client
}

// NewClient creates a new GoatX402 client
func NewClient(config Config) *Client {
	// Remove trailing slash from base URL
	config.BaseURL = strings.TrimSuffix(config.BaseURL, "/")

	return &Client{
		config: config,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// SetHTTPClient sets a custom HTTP client
func (c *Client) SetHTTPClient(client *http.Client) {
	c.httpClient = client
}

// CreateOrder creates a new payment order
// Returns an x402-compliant response normalized to the Order struct
func (c *Client) CreateOrder(ctx context.Context, params CreateOrderParams) (*Order, error) {
	// Get the raw x402 response
	x402Response, err := c.CreateOrderRaw(ctx, params)
	if err != nil {
		return nil, err
	}

	// Normalize x402 response to Order
	order := c.parseX402ToOrder(x402Response, params)
	return order, nil
}

// CreateOrderRaw creates a new payment order and returns the raw x402 response
// Use this if you need full x402 protocol access
func (c *Client) CreateOrderRaw(ctx context.Context, params CreateOrderParams) (*X402PaymentRequired, error) {
	body := map[string]any{
		"dapp_order_id": params.DappOrderID,
		"chain_id":      params.ChainID,
		"token_symbol":  params.TokenSymbol,
		"from_address":  params.FromAddress,
		"amount_wei":    params.AmountWei,
	}

	if params.TokenContract != "" {
		body["token_contract"] = params.TokenContract
	}
	if params.CallbackCalldata != "" {
		body["callback_calldata"] = params.CallbackCalldata
	}

	var x402Response X402PaymentRequired
	err := c.request(ctx, "POST", "/api/v1/orders", body, &x402Response)
	if err != nil {
		return nil, err
	}

	return &x402Response, nil
}

// parseX402ToOrder normalizes an x402 response to the Order struct
func (c *Client) parseX402ToOrder(x402 *X402PaymentRequired, params CreateOrderParams) *Order {
	opt := x402.GetPaymentOption()

	order := &Order{
		OrderID:     x402.OrderID,
		Flow:        x402.Flow,
		TokenSymbol: x402.TokenSymbol,
		X402:        x402,
	}

	// Extract data from payment option if available
	if opt != nil {
		order.TokenContract = opt.Asset
		order.PayToAddress = opt.PayTo
		order.AmountWei = opt.Amount
		order.FromChainID = FromCAIP2(opt.Network)

		// Get flow from extra if not set
		if order.Flow == "" {
			if flow, ok := opt.Extra["flow"].(string); ok {
				order.Flow = flow
			}
		}
		// Get token symbol from extra if not set
		if order.TokenSymbol == "" {
			if sym, ok := opt.Extra["tokenSymbol"].(string); ok {
				order.TokenSymbol = sym
			}
		}
	}

	// Extract data from extensions
	if x402.Extensions.GoatX402 != nil {
		order.PayToChainID = FromCAIP2(x402.Extensions.GoatX402.DestinationChain)
		order.ExpiresAt = x402.Extensions.GoatX402.ExpiresAt
	}

	// Extract calldata sign request if present
	if x402.CalldataSignRequest != nil {
		order.CalldataSignRequest = x402.CalldataSignRequest
	}

	// Fallback to request params if not set
	if order.FromChainID == 0 {
		order.FromChainID = params.ChainID
	}

	return order
}

// CreateCheckoutSession creates a server-authoritative unified hosted-checkout
// session (DIRECT or DELEGATE) over HMAC and returns
// {CheckoutID, CheckoutType, URL, ExpiresAt}. The buyer picks ONLY a token on the
// hosted page; the amount is always pinned server-side. DIRECT uses Price;
// DELEGATE uses either Price for cross-chain decimal-price checkout or
// FixedAmountWei for the legacy single-chain form.
//
// The merchant is derived from the authenticated API key; the URL is built by the
// platform from the QuickPay public origin — redirect the buyer there to pay.
//
// SIGNING NOTE: nested values cannot be HMAC-signed, so they are JSON-stringified
// (acceptable_tokens / line_items_json / public_metadata_json /
// private_metadata_json) and the server parses them after verifying the signature.
func (c *Client) CreateCheckoutSession(ctx context.Context, params CreateCheckoutSessionParams) (*CheckoutSession, error) {
	body := map[string]any{
		"checkout_type": params.CheckoutType,
	}

	// Scalars pass straight through (signable as-is).
	if params.Price != "" {
		body["price"] = params.Price
	}
	if params.ChainID != 0 {
		body["chain_id"] = params.ChainID
	}
	if params.FixedAmountWei != "" {
		body["fixed_amount_wei"] = params.FixedAmountWei
	}
	if params.CallbackCalldata != "" {
		body["callback_calldata"] = params.CallbackCalldata
	}
	if params.SuccessURL != "" {
		body["success_url"] = params.SuccessURL
	}
	if params.CancelURL != "" {
		body["cancel_url"] = params.CancelURL
	}
	if params.ClientReferenceID != "" {
		body["client_reference_id"] = params.ClientReferenceID
	}
	if params.ExpiresIn != 0 {
		body["expires_in"] = params.ExpiresIn
	}

	// Nested values are JSON-stringified so they ride as scalar (signable) fields;
	// the server JSON-parses them after verifying the HMAC signature.
	if params.AcceptableTokens != nil {
		b, err := json.Marshal(params.AcceptableTokens)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal acceptable_tokens: %w", err)
		}
		body["acceptable_tokens"] = string(b)
	}
	if params.LineItems != nil {
		b, err := json.Marshal(params.LineItems)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal line_items: %w", err)
		}
		body["line_items_json"] = string(b)
	}
	if params.PublicMetadata != nil {
		b, err := json.Marshal(params.PublicMetadata)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal public_metadata: %w", err)
		}
		body["public_metadata_json"] = string(b)
	}
	if params.PrivateMetadata != nil {
		b, err := json.Marshal(params.PrivateMetadata)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal private_metadata: %w", err)
		}
		body["private_metadata_json"] = string(b)
	}

	var result CheckoutSession
	if err := c.request(ctx, "POST", "/api/v1/checkout/sessions", body, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// CreateDelegateCheckoutSession creates a DELEGATE hosted-checkout session.
//
// Deprecated: Use CreateCheckoutSession with CheckoutType "DELEGATE". This thin
// wrapper is kept for one version; it forwards to the unified endpoint, wrapping
// the single TokenContract into AcceptableTokens=[TokenContract] (unless
// AcceptableTokens is set directly) and mapping AmountWei to FixedAmountWei.
func (c *Client) CreateDelegateCheckoutSession(ctx context.Context, params CreateDelegateCheckoutSessionParams) (*DelegateCheckoutSession, error) {
	acceptable := params.AcceptableTokens
	if acceptable == nil && params.TokenContract != "" {
		acceptable = []string{params.TokenContract}
	}
	fixed := params.FixedAmountWei
	if fixed == "" {
		fixed = params.AmountWei
	}

	session, err := c.CreateCheckoutSession(ctx, CreateCheckoutSessionParams{
		CheckoutType:      "DELEGATE",
		ChainID:           params.ChainID,
		FixedAmountWei:    fixed,
		CallbackCalldata:  params.CallbackCalldata,
		AcceptableTokens:  acceptable,
		SuccessURL:        params.SuccessURL,
		CancelURL:         params.CancelURL,
		ClientReferenceID: params.ClientReferenceID,
		ExpiresIn:         params.ExpiresIn,
		LineItems:         params.LineItems,
		PublicMetadata:    params.PublicMetadata,
		PrivateMetadata:   params.PrivateMetadata,
	})
	if err != nil {
		return nil, err
	}

	return &DelegateCheckoutSession{
		Handle:    session.CheckoutID,
		URL:       session.URL,
		ExpiresAt: session.ExpiresAt,
	}, nil
}

// GetOrderStatus retrieves order status and details (for polling)
func (c *Client) GetOrderStatus(ctx context.Context, orderID string) (*OrderStatus, error) {
	var status OrderStatus
	err := c.request(ctx, "GET", "/api/v1/orders/"+orderID, nil, &status)
	if err != nil {
		return nil, err
	}

	return &status, nil
}

// GetOrderProof retrieves the cryptographic proof for on-chain verification
// Only available after payment is confirmed
func (c *Client) GetOrderProof(ctx context.Context, orderID string) (*OrderProofResponse, error) {
	var proof OrderProofResponse
	err := c.request(ctx, "GET", "/api/v1/orders/"+orderID+"/proof", nil, &proof)
	if err != nil {
		return nil, err
	}

	return &proof, nil
}

// SubmitCalldataSignature submits user's EIP-712 signature for calldata
func (c *Client) SubmitCalldataSignature(ctx context.Context, orderID, signature string) error {
	body := map[string]any{
		"signature": signature,
	}

	var result map[string]any
	return c.request(ctx, "POST", "/api/v1/orders/"+orderID+"/calldata-signature", body, &result)
}

// CancelOrder cancels an order that is in CHECKOUT_VERIFIED status
// This will restore any reserved balance and refund fees
func (c *Client) CancelOrder(ctx context.Context, orderID string) error {
	var result map[string]any
	return c.request(ctx, "POST", "/api/v1/orders/"+orderID+"/cancel", map[string]any{}, &result)
}

// GetMerchant retrieves public merchant information (no authentication required)
func (c *Client) GetMerchant(ctx context.Context, merchantID string) (*MerchantInfo, error) {
	var merchant MerchantInfo
	err := c.publicRequest(ctx, "/merchants/"+merchantID, &merchant)
	if err != nil {
		return nil, err
	}

	return &merchant, nil
}

// request makes an authenticated API request
func (c *Client) request(ctx context.Context, method, path string, body map[string]any, result any) error {
	// Build URL
	url := c.config.BaseURL + path

	// Prepare request body
	var bodyReader io.Reader
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Build signature params
	signParams := make(map[string]string)
	for k, v := range body {
		signParams[k] = fmt.Sprintf("%v", v)
	}

	// Add auth params
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := generateRequestNonce()
	signParams["api_key"] = c.config.APIKey
	signParams["timestamp"] = timestamp
	signParams["nonce"] = nonce

	// Calculate signature
	sign := calculateSignature(signParams, c.config.APISecret)

	// Set headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.config.APIKey)
	req.Header.Set("X-Timestamp", timestamp)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Sign", sign)

	// Send request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	// Check for errors (402 is expected for order creation)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPaymentRequired {
		// Try to parse error response - Fiber uses "message", standard APIs use "error"
		var errResp struct {
			Error   string `json:"error"`
			Message string `json:"message"`
			Code    string `json:"code"`
		}
		if json.Unmarshal(respBody, &errResp) == nil {
			msg := errResp.Error
			if msg == "" {
				msg = errResp.Message
			}
			if msg != "" {
				return &APIError{
					Message:      msg,
					Code:         errResp.Code,
					Status:       resp.StatusCode,
					ResponseBody: string(respBody),
				}
			}
		}
		// Fallback: include full response body
		return &APIError{
			Message:      fmt.Sprintf("HTTP %d", resp.StatusCode),
			Status:       resp.StatusCode,
			ResponseBody: string(respBody),
		}
	}

	// Parse response
	if result != nil {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("failed to parse response: %w", err)
		}
	}

	return nil
}

// publicRequest makes an unauthenticated API request
func (c *Client) publicRequest(ctx context.Context, path string, result any) error {
	url := c.config.BaseURL + path

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		// Try to parse error response - Fiber uses "message", standard APIs use "error"
		var errResp struct {
			Error   string `json:"error"`
			Message string `json:"message"`
			Code    string `json:"code"`
		}
		if json.Unmarshal(respBody, &errResp) == nil {
			msg := errResp.Error
			if msg == "" {
				msg = errResp.Message
			}
			if msg != "" {
				return &APIError{
					Message:      msg,
					Code:         errResp.Code,
					Status:       resp.StatusCode,
					ResponseBody: string(respBody),
				}
			}
		}
		// Fallback: include full response body
		return &APIError{
			Message:      fmt.Sprintf("HTTP %d", resp.StatusCode),
			Status:       resp.StatusCode,
			ResponseBody: string(respBody),
		}
	}

	if result != nil {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("failed to parse response: %w", err)
		}
	}

	return nil
}

// WaitForConfirmation polls for order confirmation
func (c *Client) WaitForConfirmation(ctx context.Context, orderID string, timeout, interval time.Duration) (*OrderStatus, error) {
	if timeout == 0 {
		timeout = 5 * time.Minute
	}
	if interval == 0 {
		interval = 3 * time.Second
	}

	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("timeout waiting for order %s confirmation", orderID)
			}

			status, err := c.GetOrderStatus(ctx, orderID)
			if err != nil {
				continue // Retry on error
			}

			// Check for terminal states
			switch status.Status {
			case "PAYMENT_CONFIRMED", "FAILED", "EXPIRED", "CANCELLED":
				return status, nil
			}
		}
	}
}
