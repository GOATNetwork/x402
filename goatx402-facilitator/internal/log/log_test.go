package log

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// sensitiveValues holds the unique secret strings used across the redaction
// tests. If ANY of these appear in a log line — at any depth — the redactor
// has failed. The test logger sets RedactedPlaceholder over them.
var sensitiveValues = []string{
	"Bearer-token-MUST-NOT-LEAK",
	"payer-token-MUST-NOT-LEAK",
	"admin-token-MUST-NOT-LEAK",
	"x-payment-blob-MUST-NOT-LEAK",
	"signature-blob-MUST-NOT-LEAK",
	"public-key-MUST-NOT-LEAK",
	"payload-hash-MUST-NOT-LEAK",
	"submission-payload-hash-MUST-NOT-LEAK",
	"receipt-payload-hash-MUST-NOT-LEAK",
	"participant-sig-MUST-NOT-LEAK",
	"dedup-id-MUST-NOT-LEAK",
	"command-id-MUST-NOT-LEAK",
	"payment-request-contract-id-MUST-NOT-LEAK",
}

// TestRedaction_AllRule4Names exercises every name in the §9.2 rule 4 list
// across two casings (canonical + lower) and asserts none of the sensitive
// values appear in the JSONL output. This is the surface-key contract.
func TestRedaction_AllRule4Names(t *testing.T) {
	cases := []struct {
		key       string
		value     string
		mustNotLeak string
	}{
		{"Authorization", "Bearer-token-MUST-NOT-LEAK", "Bearer-token-MUST-NOT-LEAK"},
		{"authorization", "Bearer-token-MUST-NOT-LEAK", "Bearer-token-MUST-NOT-LEAK"},
		{"X-Payer-Token", "payer-token-MUST-NOT-LEAK", "payer-token-MUST-NOT-LEAK"},
		{"x-payer-token", "payer-token-MUST-NOT-LEAK", "payer-token-MUST-NOT-LEAK"},
		{"ADMIN_TOKEN", "admin-token-MUST-NOT-LEAK", "admin-token-MUST-NOT-LEAK"},
		{"X-Admin-Token", "admin-token-MUST-NOT-LEAK", "admin-token-MUST-NOT-LEAK"},
		{"X-PAYMENT", "x-payment-blob-MUST-NOT-LEAK", "x-payment-blob-MUST-NOT-LEAK"},
		{"signature", "signature-blob-MUST-NOT-LEAK", "signature-blob-MUST-NOT-LEAK"},
		{"publicKey", "public-key-MUST-NOT-LEAK", "public-key-MUST-NOT-LEAK"},
		{"payload_hash", "payload-hash-MUST-NOT-LEAK", "payload-hash-MUST-NOT-LEAK"},
		{"submissionPayloadHash", "submission-payload-hash-MUST-NOT-LEAK", "submission-payload-hash-MUST-NOT-LEAK"},
		{"receiptPayloadHash", "receipt-payload-hash-MUST-NOT-LEAK", "receipt-payload-hash-MUST-NOT-LEAK"},
		{"participantSig", "participant-sig-MUST-NOT-LEAK", "participant-sig-MUST-NOT-LEAK"},
		{"dedupId", "dedup-id-MUST-NOT-LEAK", "dedup-id-MUST-NOT-LEAK"},
		{"command_id", "command-id-MUST-NOT-LEAK", "command-id-MUST-NOT-LEAK"},
		{"commandId", "command-id-MUST-NOT-LEAK", "command-id-MUST-NOT-LEAK"},
		{"payment_request_contract_id", "payment-request-contract-id-MUST-NOT-LEAK", "payment-request-contract-id-MUST-NOT-LEAK"},
		{"paymentRequestContractId", "payment-request-contract-id-MUST-NOT-LEAK", "payment-request-contract-id-MUST-NOT-LEAK"},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			var buf bytes.Buffer
			l := New(&buf, Options{Level: slog.LevelDebug})
			l.Info("redact me", slog.String(tc.key, tc.value))

			out := buf.String()
			if strings.Contains(out, tc.mustNotLeak) {
				t.Errorf("key %q: sensitive value leaked in JSONL output:\n%s", tc.key, out)
			}
			if !strings.Contains(out, RedactedPlaceholder) {
				t.Errorf("key %q: expected redacted placeholder in output:\n%s", tc.key, out)
			}
			assertValidJSONL(t, out)
		})
	}
}

// TestRedaction_DeepWalk_ReceiptUnderOrderEvents is the §7 Task 10 fixture
// requirement: a full receipt envelope logged under
// `order_events.reason` must not leak ANY sensitive field value, including
// the nested `signature`.
func TestRedaction_DeepWalk_ReceiptUnderOrderEvents(t *testing.T) {
	receipt := map[string]any{
		"orderId":               "order-123",
		"amount":                "1.00",
		"merchantRequestId":     "req-abc",
		"trustedIssuer":         "facilitator-party",
		"submissionPayloadHash": "submission-payload-hash-MUST-NOT-LEAK",
		"receiptPayloadHash":    "receipt-payload-hash-MUST-NOT-LEAK",
		"command_id":            "command-id-MUST-NOT-LEAK",
		"dedupId":               "dedup-id-MUST-NOT-LEAK",
		"signature":             "signature-blob-MUST-NOT-LEAK",
		"publicKey":             "public-key-MUST-NOT-LEAK",
		"participantSig":        "participant-sig-MUST-NOT-LEAK",
		"payment_request_contract_id": "payment-request-contract-id-MUST-NOT-LEAK",
		// double-nest one level deeper to exercise the recursion path
		"meta": map[string]any{
			"hops": []any{
				map[string]any{
					"signature": "signature-blob-MUST-NOT-LEAK",
					"hop_index": 0,
				},
			},
			"Authorization": "Bearer-token-MUST-NOT-LEAK",
		},
	}
	orderEvents := []map[string]any{
		{
			"kind":   "SETTLEMENT_PERSISTED",
			"reason": receipt,
		},
	}
	var buf bytes.Buffer
	l := New(&buf, Options{Level: slog.LevelDebug})
	l = WithOrderID(l, "order-123")
	l.Info("settlement persisted",
		slog.Any("order_events", orderEvents),
	)

	out := buf.String()
	for _, secret := range sensitiveValues {
		if strings.Contains(out, secret) {
			t.Errorf("deep-walk redaction missed value %q in output:\n%s", secret, out)
		}
	}

	// order_id correlator must still be present.
	if !strings.Contains(out, `"order_id":"order-123"`) {
		t.Errorf("order_id correlator missing from output:\n%s", out)
	}
	assertValidJSONL(t, out)
}

// TestRedaction_DeepWalk_StructValue verifies the reflection walker also
// catches sensitive fields buried inside a Go struct (not just maps), since
// handlers routinely pass typed values to slog.
func TestRedaction_DeepWalk_StructValue(t *testing.T) {
	type Receipt struct {
		OrderID   string `json:"orderId"`
		Signature string `json:"signature"`
		Inner     struct {
			PublicKey string `json:"publicKey"`
		} `json:"inner"`
	}
	r := Receipt{OrderID: "o1", Signature: "signature-blob-MUST-NOT-LEAK"}
	r.Inner.PublicKey = "public-key-MUST-NOT-LEAK"

	var buf bytes.Buffer
	l := New(&buf, Options{Level: slog.LevelDebug})
	l.Info("typed receipt", slog.Any("receipt", r))

	out := buf.String()
	if strings.Contains(out, "signature-blob-MUST-NOT-LEAK") {
		t.Errorf("struct field signature leaked:\n%s", out)
	}
	if strings.Contains(out, "public-key-MUST-NOT-LEAK") {
		t.Errorf("nested struct publicKey leaked:\n%s", out)
	}
	if !strings.Contains(out, `"orderId":"o1"`) {
		t.Errorf("non-sensitive field dropped:\n%s", out)
	}
	assertValidJSONL(t, out)
}

// TestRedaction_DeepWalk_SlogGroup checks that slog Groups are walked too.
func TestRedaction_DeepWalk_SlogGroup(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, Options{Level: slog.LevelDebug})
	l.Info("group test",
		slog.Group("request",
			slog.String("Authorization", "Bearer-token-MUST-NOT-LEAK"),
			slog.String("path", "/api/v1/orders"),
		),
	)
	out := buf.String()
	if strings.Contains(out, "Bearer-token-MUST-NOT-LEAK") {
		t.Errorf("slog.Group leaked sensitive value:\n%s", out)
	}
	if !strings.Contains(out, `"path":"/api/v1/orders"`) {
		t.Errorf("expected non-sensitive group field; output:\n%s", out)
	}
	assertValidJSONL(t, out)
}

// TestRedaction_WithOrderID verifies the correlator helper still attaches
// order_id and persists across With() calls without leaking through the
// scrubber.
func TestRedaction_WithOrderID(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, Options{Level: slog.LevelDebug})
	l = WithOrderID(l, "order-99")
	l.Info("hello")
	if !strings.Contains(buf.String(), `"order_id":"order-99"`) {
		t.Errorf("order_id correlator missing:\n%s", buf.String())
	}
	assertValidJSONL(t, buf.String())
}

// TestRedaction_JSONRawMessageEnvelope ensures envelopes serialised to JSON
// before logging still get redacted (e.g. when handlers log a json.RawMessage
// directly rather than the structured Go value).
func TestRedaction_JSONRawMessageEnvelope(t *testing.T) {
	raw := json.RawMessage(`{"orderId":"o1","signature":"signature-blob-MUST-NOT-LEAK","nested":{"publicKey":"public-key-MUST-NOT-LEAK"}}`)
	var buf bytes.Buffer
	l := New(&buf, Options{Level: slog.LevelDebug})
	l.Info("raw envelope", slog.Any("envelope", raw))

	out := buf.String()
	if strings.Contains(out, "signature-blob-MUST-NOT-LEAK") {
		t.Errorf("json.RawMessage signature leaked:\n%s", out)
	}
	if strings.Contains(out, "public-key-MUST-NOT-LEAK") {
		t.Errorf("json.RawMessage publicKey leaked:\n%s", out)
	}
	assertValidJSONL(t, out)
}

// assertValidJSONL parses every newline-delimited line as JSON. Acceptance
// criterion: "logs are valid JSONL".
func assertValidJSONL(t *testing.T, s string) {
	t.Helper()
	for i, line := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		if line == "" {
			continue
		}
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Errorf("line %d is not valid JSON: %v\nline:%s", i, err, line)
		}
	}
}
