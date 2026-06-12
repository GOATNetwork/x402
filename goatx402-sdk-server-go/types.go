package goatx402

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Config holds the SDK configuration
type Config struct {
	// BaseURL is the GoatX402 API base URL
	BaseURL string
	// APIKey is the merchant API key
	APIKey string
	// APISecret is the merchant API secret (keep this secure!)
	APISecret string
}

// CreateOrderParams contains parameters for creating an order
type CreateOrderParams struct {
	// DappOrderID is a unique order ID from your application
	DappOrderID string `json:"dapp_order_id"`
	// ChainID is the source blockchain chain ID (where user pays)
	ChainID int `json:"chain_id"`
	// TokenSymbol is the token symbol (e.g., "USDC", "USDT")
	TokenSymbol string `json:"token_symbol"`
	// TokenContract is the token contract address (optional, looked up by symbol)
	TokenContract string `json:"token_contract,omitempty"`
	// FromAddress is the payer's wallet address
	FromAddress string `json:"from_address"`
	// AmountWei is the payment amount in wei (string for big numbers)
	AmountWei string `json:"amount_wei"`
	// CallbackCalldata is optional calldata for DELEGATE merchants
	CallbackCalldata string `json:"callback_calldata,omitempty"`
}

// x402 Protocol Types
// See: https://github.com/coinbase/x402

// X402Resource describes the protected resource
type X402Resource struct {
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// X402PaymentOption describes one payment method the server accepts
type X402PaymentOption struct {
	Scheme            string         `json:"scheme"`
	Network           string         `json:"network"` // CAIP-2 format: eip155:97
	Amount            string         `json:"amount"`  // Atomic units as string
	Asset             string         `json:"asset"`   // Token contract address
	PayTo             string         `json:"payTo"`   // Recipient address
	MaxTimeoutSeconds int            `json:"maxTimeoutSeconds"`
	Extra             map[string]any `json:"extra,omitempty"`
}

// X402GoatExtension contains GoatX402-specific extension data
type X402GoatExtension struct {
	DestinationChain  string `json:"destinationChain"`            // CAIP-2 format
	ExpiresAt         int64  `json:"expiresAt"`                   // Unix timestamp
	SignatureEndpoint string `json:"signatureEndpoint,omitempty"` // Only present for EIP-3009 flow
	PaymentMethod     string `json:"paymentMethod"`               // "transfer" or "eip3009-signature"
	ReceiveType       string `json:"receiveType,omitempty"`       // "DIRECT", "DELEGATE", or "VERIFY"
}

// X402PaymentRequired is the x402-compliant response from order creation
type X402PaymentRequired struct {
	// x402 standard fields
	X402Version int                 `json:"x402Version"`
	Error       string              `json:"error,omitempty"`
	Resource    X402Resource        `json:"resource"`
	Accepts     []X402PaymentOption `json:"accepts"`
	Extensions  struct {
		GoatX402 *X402GoatExtension `json:"goatx402,omitempty"`
	} `json:"extensions,omitempty"`

	// Backward compatibility fields
	OrderID     string `json:"order_id"`
	Flow        string `json:"flow"`
	TokenSymbol string `json:"token_symbol"`

	// Calldata sign request for DELEGATE merchants with callback
	CalldataSignRequest *CalldataSignRequest `json:"calldata_sign_request,omitempty"`
}

// GetPaymentOption returns the first payment option (or nil if none)
func (x *X402PaymentRequired) GetPaymentOption() *X402PaymentOption {
	if len(x.Accepts) > 0 {
		return &x.Accepts[0]
	}
	return nil
}

// GetSourceChainID extracts the source chain ID from the payment network (CAIP-2)
func (x *X402PaymentRequired) GetSourceChainID() int {
	opt := x.GetPaymentOption()
	if opt == nil {
		return 0
	}
	return FromCAIP2(opt.Network)
}

// GetDestinationChainID extracts the destination chain ID from extensions
func (x *X402PaymentRequired) GetDestinationChainID() int {
	if x.Extensions.GoatX402 == nil {
		return 0
	}
	return FromCAIP2(x.Extensions.GoatX402.DestinationChain)
}

// Order represents a payment order (normalized from x402 response)
type Order struct {
	// OrderID is the GoatX402 order ID
	OrderID string `json:"order_id"`
	// Flow is the payment flow type
	Flow string `json:"flow"`
	// TokenSymbol is the token symbol
	TokenSymbol string `json:"token_symbol"`
	// TokenContract is the token contract address on source chain
	TokenContract string `json:"token_contract"`
	// PayToAddress is the address to send payment to
	PayToAddress string `json:"pay_to_address"`
	// FromChainID is the source chain ID (where user pays)
	FromChainID int `json:"from_chain_id"`
	// PayToChainID is the destination chain ID (where merchant receives)
	PayToChainID int `json:"pay_to_chain_id"`
	// AmountWei is the payment amount
	AmountWei string `json:"amount_wei"`
	// ExpiresAt is the order expiration timestamp (unix seconds)
	ExpiresAt int64 `json:"expires_at"`
	// CalldataSignRequest contains EIP-712 data for calldata signing (optional)
	CalldataSignRequest *CalldataSignRequest `json:"calldata_sign_request,omitempty"`
	// X402 is the raw x402 response for advanced use cases
	X402 *X402PaymentRequired `json:"x402,omitempty"`
}

// CalldataSignRequest contains EIP-712 typed data for signing
// Message can be either Eip3009CalldataMessage or Permit2CalldataMessage depending on the flow
type CalldataSignRequest struct {
	Domain      EIP712Domain            `json:"domain"`
	Types       map[string][]EIP712Type `json:"types"`
	PrimaryType string                  `json:"primaryType"`
	Message     any                     `json:"message"`
}

// EIP712Domain is the EIP-712 domain separator
type EIP712Domain struct {
	Name              string `json:"name"`
	Version           string `json:"version"`
	ChainID           int    `json:"chainId"`
	VerifyingContract string `json:"verifyingContract"`
}

// EIP712Type defines a field in EIP-712 typed data
type EIP712Type struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Eip3009CalldataMessage is the EIP-712 message for EIP-3009 calldata signature
// PrimaryType: "Eip3009CallbackData"
type Eip3009CalldataMessage struct {
	Token         string `json:"token"`         // Token contract address
	Owner         string `json:"owner"`         // TSS wallet address
	Payer         string `json:"payer"`         // User address
	Amount        string `json:"amount"`        // Payment amount in wei
	OrderId       string `json:"orderId"`       // Order ID hash (bytes32) - links to specific order
	CalldataNonce string `json:"calldataNonce"` // Replay protection nonce
	Deadline      string `json:"deadline"`      // Signature expiry timestamp
	CalldataHash  string `json:"calldataHash"`  // keccak256 hash of calldata
}

// Permit2CalldataMessage is the EIP-712 message for Permit2 calldata signature
// PrimaryType: "Permit2CallbackData"
type Permit2CalldataMessage struct {
	Permit2       string `json:"permit2"`       // Permit2 contract address
	Token         string `json:"token"`         // Token contract address
	Owner         string `json:"owner"`         // TSS wallet address
	Payer         string `json:"payer"`         // User address
	Amount        string `json:"amount"`        // Payment amount in wei
	OrderId       string `json:"orderId"`       // Order ID hash (bytes32) - links to specific order
	CalldataNonce string `json:"calldataNonce"` // Replay protection nonce
	Deadline      string `json:"deadline"`      // Signature expiry timestamp
	CalldataHash  string `json:"calldataHash"`  // keccak256 hash of calldata
}

// OrderStatus contains order status and details (for polling)
type OrderStatus struct {
	OrderID       string `json:"order_id"`
	MerchantID    string `json:"merchant_id"`
	DappOrderID   string `json:"dapp_order_id"`
	ChainID       int    `json:"chain_id"`
	TokenContract string `json:"token_contract"`
	TokenSymbol   string `json:"token_symbol"`
	FromAddress   string `json:"from_address"`
	AmountWei     string `json:"amount_wei"`
	Status        string `json:"status"`
	TxHash        string `json:"tx_hash,omitempty"`
	ConfirmedAt   string `json:"confirmed_at,omitempty"`
}

// OrderProofPayload contains the proof payload data
type OrderProofPayload struct {
	OrderID   string `json:"order_id"`
	TxHash    string `json:"tx_hash"`
	LogIndex  int    `json:"log_index"`
	FromAddr  string `json:"from_addr"`
	ToAddr    string `json:"to_addr"`
	AmountWei string `json:"amount_wei"`
	ChainID   int    `json:"chain_id"`
	Flow      string `json:"flow"`
}

// OrderProofResponse contains the cryptographic proof for on-chain verification
type OrderProofResponse struct {
	Payload   OrderProofPayload `json:"payload"`
	Signature string            `json:"signature"`
}

// MerchantInfo contains public merchant information
type MerchantInfo struct {
	MerchantID      string          `json:"merchant_id"`
	Name            string          `json:"name"`
	Logo            string          `json:"logo,omitempty"`
	ReceiveType     string          `json:"receive_type"`
	SupportedTokens []MerchantToken `json:"supported_tokens"`
}

// MerchantToken represents a supported token
type MerchantToken struct {
	ChainID       int    `json:"chain_id"`
	Symbol        string `json:"symbol"`
	TokenContract string `json:"token_contract"`
	Decimals      int    `json:"decimals"`
}

// APIError represents an API error response
type APIError struct {
	Message      string `json:"error"`
	Code         string `json:"code,omitempty"`
	Status       int    `json:"-"`
	ResponseBody string `json:"-"` // Full response body for debugging
}

func (e *APIError) Error() string {
	if e.ResponseBody != "" && e.ResponseBody != e.Message {
		return fmt.Sprintf("%s (response: %s)", e.Message, e.ResponseBody)
	}
	return e.Message
}

// CAIP-2 helper functions
// See: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md

// ToCAIP2 converts a chain ID to CAIP-2 format
// e.g., 97 -> "eip155:97"
func ToCAIP2(chainID int) string {
	return fmt.Sprintf("eip155:%d", chainID)
}

// FromCAIP2 parses a CAIP-2 network identifier to chain ID
// e.g., "eip155:97" -> 97
func FromCAIP2(network string) int {
	if !strings.HasPrefix(network, "eip155:") {
		return 0
	}
	parts := strings.Split(network, ":")
	if len(parts) != 2 {
		return 0
	}
	chainID, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0
	}
	return chainID
}

// ParseX402Header parses a base64-encoded PAYMENT-REQUIRED header
func ParseX402Header(headerValue string) (*X402PaymentRequired, error) {
	decoded, err := base64.StdEncoding.DecodeString(headerValue)
	if err != nil {
		return nil, fmt.Errorf("failed to decode x402 header: %w", err)
	}

	var x402 X402PaymentRequired
	if err := json.Unmarshal(decoded, &x402); err != nil {
		return nil, fmt.Errorf("failed to parse x402 header: %w", err)
	}

	return &x402, nil
}
