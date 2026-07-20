package goatflow

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testClient(server *httptest.Server) *Client {
	return NewClient(Config{BaseURL: server.URL, APIKey: "test-key", APISecret: "test-secret"})
}

func TestCreateOrderRawAcceptsPaymentRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/orders" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"x402Version":2,"resource":{"url":"u"},"accepts":[],"order_id":"order_1","flow":"ERC20_DIRECT","token_symbol":"USDC"}`))
	}))
	defer server.Close()

	response, err := testClient(server).CreateOrderRaw(context.Background(), CreateOrderParams{
		DappOrderID: "dapp_1",
		ChainID:     137,
		TokenSymbol: "USDC",
		FromAddress: "0xPayer",
		AmountWei:   "1000000",
	})
	if err != nil {
		t.Fatalf("CreateOrderRaw returned error: %v", err)
	}
	if response.OrderID != "order_1" {
		t.Fatalf("OrderID = %q, want order_1", response.OrderID)
	}
}

func TestNonCreateEndpointRejectsPaymentRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"error":"payment required elsewhere","code":"UNEXPECTED_402"}`))
	}))
	defer server.Close()

	err := testClient(server).CancelOrder(context.Background(), "order_1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("CancelOrder error = %T %v, want *APIError", err, err)
	}
	if apiErr.Status != http.StatusPaymentRequired || apiErr.Code != "UNEXPECTED_402" {
		t.Fatalf("APIError = %+v", apiErr)
	}
}

func TestGetOrderProofDecodesCurrentWireShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"payload":{"order_id":"order_1","tx_hash":"0x1","log_index":2,"from_addr":"0xA","to_addr":"0xB","amount_wei":"10","from_chain_id":137,"status":"INVOICED"},"signature":"0xhash"}`))
	}))
	defer server.Close()

	proof, err := testClient(server).GetOrderProof(context.Background(), "order_1")
	if err != nil {
		t.Fatalf("GetOrderProof returned error: %v", err)
	}
	if proof.Payload.FromChainID != 137 || proof.Payload.Status != "INVOICED" || proof.Signature != "0xhash" {
		t.Fatalf("proof = %+v", proof)
	}
}
