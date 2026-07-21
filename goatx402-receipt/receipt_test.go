package receipt_test

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xeipuuv/gojsonschema"
	"golang.org/x/text/unicode/norm"

	receipt "github.com/goatnetwork/goatx402-receipt"
)

// validReceipt is the fixture used across the canonicalisation, schema, and
// golden-envelope tests. It enumerates every round-3 field so a regression
// that drops one fails on every path that exercises this helper.
func validReceipt() receipt.CantonReceipt {
	return receipt.CantonReceipt{
		Version:                  receipt.SchemaVersion,
		Domain:                   receipt.DomainV1,
		OrderID:                  "0190f7d2-1234-7890-abcd-1234567890ab",
		LedgerID:                 "participant-localnet",
		TransactionID:            "tx-deadbeef-0001",
		ContractID:               "00:Holding:merchant-001",
		PaymentRequestContractID: "00:PaymentRequest:0001",
		ParticipantPartyID:       "participant::1220abc",
		Merchant:                 "Merchant::1220abc",
		Payer:                    "Payer::1220abc",
		Amount:                   "1.5",
		Currency:                 "USD-canton",
		TrustedIssuer:            "Issuer::1220abc",
		Resource:                 "/resource",
		MerchantRequestID:        "abcdef0123456789abcdef0123",
		ExpiresAtHTTP:            1_715_600_000_000,
		ExpiresAtDaml:            1_715_600_030_000,
		SignatureScheme:          receipt.SignatureSchemeEd25519,
		Signature:                "AAAAQEdMV1pf3rPLO5VnAFy1QvX5jVHJjOq8sX1Q==",
		ReceiptPayloadHash:       "yQqDk+Hh9pMR7QY8FaC0e+vT0R8Hf3kJ0YwK0RsBb0M=",
		CompletedAt:              1_715_600_002_000,
	}
}

// TestCanonical_Deterministic asserts that Canonical() returns byte-identical
// output across N independent calls on a structurally-equal receipt, and that
// the JSON body sub-section parses with sorted keys. Resolves F6 "Canonical()
// is deterministic across runs".
func TestCanonical_Deterministic(t *testing.T) {
	r := validReceipt()

	first, err := r.Canonical()
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	if !strings.HasPrefix(string(first), receipt.DomainV1+"\x00") {
		t.Fatalf("expected domain prefix %q, got %q", receipt.DomainV1, first[:len(receipt.DomainV1)+1])
	}

	for i := 0; i < 64; i++ {
		next, err := r.Canonical()
		if err != nil {
			t.Fatalf("Canonical iter %d: %v", i, err)
		}
		if !bytes.Equal(first, next) {
			t.Fatalf("non-deterministic: iter %d produced different bytes", i)
		}
	}
}

// TestCanonical_ExcludesSignatureAndPayloadHash pins the §6.4 invariant: the
// signature and receiptPayloadHash fields are NOT in the canonical preimage.
// Mutating either must not change Canonical()'s output.
func TestCanonical_ExcludesSignatureAndPayloadHash(t *testing.T) {
	base := validReceipt()
	baseBytes, err := base.Canonical()
	if err != nil {
		t.Fatalf("Canonical base: %v", err)
	}

	mutSig := base
	mutSig.Signature = "totally-different-signature-bytes"
	got, err := mutSig.Canonical()
	if err != nil {
		t.Fatalf("Canonical mutSig: %v", err)
	}
	if !bytes.Equal(baseBytes, got) {
		t.Fatal("Canonical changed when signature mutated; signature must be outside the preimage")
	}

	mutHash := base
	mutHash.ReceiptPayloadHash = "another-display-only-digest"
	got, err = mutHash.Canonical()
	if err != nil {
		t.Fatalf("Canonical mutHash: %v", err)
	}
	if !bytes.Equal(baseBytes, got) {
		t.Fatal("Canonical changed when receiptPayloadHash mutated; receiptPayloadHash must be outside the preimage")
	}
}

// TestCanonical_FieldMutationsChangeOutput is the contrapositive: every
// field that IS in the preimage must alter Canonical()'s output. Walks each
// signed field individually so a regression that accidentally drops one is
// pinpointed.
func TestCanonical_FieldMutationsChangeOutput(t *testing.T) {
	base := validReceipt()
	baseBytes, err := base.Canonical()
	if err != nil {
		t.Fatalf("Canonical base: %v", err)
	}

	mutations := []struct {
		name string
		mut  func(*receipt.CantonReceipt)
	}{
		{"version", func(r *receipt.CantonReceipt) { r.Version = "9.9" }},
		{"orderId", func(r *receipt.CantonReceipt) { r.OrderID = r.OrderID + "x" }},
		{"ledgerId", func(r *receipt.CantonReceipt) { r.LedgerID = "other-ledger" }},
		{"transactionId", func(r *receipt.CantonReceipt) { r.TransactionID = "tx-other" }},
		{"contractId", func(r *receipt.CantonReceipt) { r.ContractID = "00:Holding:other" }},
		{"paymentRequestContractId", func(r *receipt.CantonReceipt) { r.PaymentRequestContractID = "00:PaymentRequest:other" }},
		{"participantPartyId", func(r *receipt.CantonReceipt) { r.ParticipantPartyID = "other-participant" }},
		{"merchant", func(r *receipt.CantonReceipt) { r.Merchant = "OtherMerchant::1220abc" }},
		{"payer", func(r *receipt.CantonReceipt) { r.Payer = "OtherPayer::1220abc" }},
		{"amount", func(r *receipt.CantonReceipt) { r.Amount = "2.0" }},
		{"currency", func(r *receipt.CantonReceipt) { r.Currency = "EUR-canton" }},
		{"trustedIssuer", func(r *receipt.CantonReceipt) { r.TrustedIssuer = "OtherIssuer::1220abc" }},
		{"resource", func(r *receipt.CantonReceipt) { r.Resource = "/other" }},
		{"merchantRequestId", func(r *receipt.CantonReceipt) { r.MerchantRequestID = "zzzzz0123456789abcdef0123" }},
		{"expiresAtHttp", func(r *receipt.CantonReceipt) { r.ExpiresAtHTTP += 1000 }},
		{"expiresAtDaml", func(r *receipt.CantonReceipt) { r.ExpiresAtDaml += 1000 }},
		{"signatureScheme", func(r *receipt.CantonReceipt) { r.SignatureScheme = "Ed25519ph" }},
		{"completedAt", func(r *receipt.CantonReceipt) { r.CompletedAt += 1 }},
		{"domain", func(r *receipt.CantonReceipt) { r.Domain = receipt.DomainV1 + ":alt" }},
	}

	for _, m := range mutations {
		t.Run(m.name, func(t *testing.T) {
			mut := base
			m.mut(&mut)
			got, err := mut.Canonical()
			if err != nil {
				t.Fatalf("Canonical: %v", err)
			}
			if bytes.Equal(baseBytes, got) {
				t.Fatalf("mutating %s must alter canonical bytes", m.name)
			}
		})
	}
}

// TestCanonical_NFCNormalisation pins UTF-8 NFC normalisation. The receipt
// memo and party-id strings can carry combining marks; canonical bytes must
// be byte-identical for NFD and NFC inputs that compose to the same string.
func TestCanonical_NFCNormalisation(t *testing.T) {
	nfd := validReceipt()
	nfd.Merchant = "Café-Merchant" // "Café-Merchant" with combining acute

	nfc := nfd
	nfc.Merchant = norm.NFC.String(nfd.Merchant)
	if nfd.Merchant == nfc.Merchant {
		t.Fatalf("test setup: expected NFD vs NFC to differ pre-normalisation")
	}

	a, err := nfd.Canonical()
	if err != nil {
		t.Fatalf("Canonical nfd: %v", err)
	}
	b, err := nfc.Canonical()
	if err != nil {
		t.Fatalf("Canonical nfc: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("NFC-normalisation drift: NFD-input and NFC-input must produce identical canonical bytes")
	}
}

// TestCanonical_DomainPrefix_Required asserts Canonical fails fast on an
// empty domain. Domain separation is load-bearing for the signature; we
// refuse to emit a preimage without it.
func TestCanonical_DomainPrefix_Required(t *testing.T) {
	r := validReceipt()
	r.Domain = ""
	if _, err := r.Canonical(); err == nil {
		t.Fatal("expected error when Domain is empty")
	}
}

// TestPropertyRandomRoundTrip is the property test required by Task 4:
// N random receipts → JSON → struct → Canonical → byte-identical.
func TestPropertyRandomRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(0xC0FFEE))
	for i := 0; i < 200; i++ {
		original := randomReceipt(rng)
		raw, err := json.Marshal(original)
		if err != nil {
			t.Fatalf("iter %d: marshal: %v", i, err)
		}
		var decoded receipt.CantonReceipt
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("iter %d: unmarshal: %v", i, err)
		}

		c1, err := original.Canonical()
		if err != nil {
			t.Fatalf("iter %d: canonical original: %v", i, err)
		}
		c2, err := decoded.Canonical()
		if err != nil {
			t.Fatalf("iter %d: canonical decoded: %v", i, err)
		}
		if !bytes.Equal(c1, c2) {
			t.Fatalf("iter %d: round-trip canonical mismatch", i)
		}
	}
}

func randomReceipt(rng *rand.Rand) receipt.CantonReceipt {
	r := validReceipt()
	r.OrderID = randHex(rng, 32)
	r.TransactionID = "tx-" + randHex(rng, 16)
	r.ContractID = "00:Holding:" + randHex(rng, 8)
	r.PaymentRequestContractID = "00:PaymentRequest:" + randHex(rng, 8)
	r.ParticipantPartyID = "participant::" + randHex(rng, 12)
	r.Merchant = "Merchant::" + randHex(rng, 12)
	r.Payer = "Payer::" + randHex(rng, 12)
	r.TrustedIssuer = "Issuer::" + randHex(rng, 12)
	r.Resource = "/r/" + randHex(rng, 6)
	r.MerchantRequestID = randHexLen(rng, 22) // matches schema 22-64
	r.ExpiresAtHTTP = 1_700_000_000_000 + rng.Int63n(1_000_000_000)
	r.ExpiresAtDaml = r.ExpiresAtHTTP + 30_000
	r.CompletedAt = r.ExpiresAtHTTP - rng.Int63n(60_000)
	return r
}

func randHex(rng *rand.Rand, n int) string {
	const hex = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = hex[rng.Intn(len(hex))]
	}
	return string(b)
}

func randHexLen(rng *rand.Rand, n int) string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
	b := make([]byte, n)
	for i := range b {
		b[i] = charset[rng.Intn(len(charset))]
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// JSON Schema acceptance
// ---------------------------------------------------------------------------

func loadSchemaPath(t *testing.T) string {
	t.Helper()
	// Walk upward from the package directory until we find docs/canton-receipt.schema.json.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := wd
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "docs", "canton-receipt.schema.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("schema file not found from %s", wd)
	return ""
}

func loadSchema(t *testing.T) *gojsonschema.Schema {
	t.Helper()
	path := loadSchemaPath(t)
	loader := gojsonschema.NewReferenceLoader("file://" + path)
	schema, err := gojsonschema.NewSchema(loader)
	if err != nil {
		t.Fatalf("load schema: %v", err)
	}
	return schema
}

func validateAgainstSchema(t *testing.T, schema *gojsonschema.Schema, r receipt.CantonReceipt) *gojsonschema.Result {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return validateRaw(t, schema, raw)
}

func validateRaw(t *testing.T, schema *gojsonschema.Schema, raw []byte) *gojsonschema.Result {
	t.Helper()
	result, err := schema.Validate(gojsonschema.NewBytesLoader(raw))
	if err != nil {
		t.Fatalf("schema.Validate: %v", err)
	}
	return result
}

func TestSchema_ValidatesGoodReceipt(t *testing.T) {
	schema := loadSchema(t)
	result := validateAgainstSchema(t, schema, validReceipt())
	if !result.Valid() {
		var msgs []string
		for _, e := range result.Errors() {
			msgs = append(msgs, e.String())
		}
		t.Fatalf("expected schema validation to pass, got errors: %s", strings.Join(msgs, "; "))
	}
}

// TestSchema_RejectsMissingRoundThreeFields is the load-bearing acceptance for
// round-3 Codex P1: schema MUST fail on a sample missing any of trustedIssuer,
// merchantRequestId, expiresAtHttp, expiresAtDaml, receiptPayloadHash.
func TestSchema_RejectsMissingRoundThreeFields(t *testing.T) {
	schema := loadSchema(t)
	cases := []string{
		"trustedIssuer",
		"merchantRequestId",
		"expiresAtHttp",
		"expiresAtDaml",
		"receiptPayloadHash",
	}
	for _, field := range cases {
		t.Run("missing_"+field, func(t *testing.T) {
			raw, err := json.Marshal(validReceipt())
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var asMap map[string]any
			if err := json.Unmarshal(raw, &asMap); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			delete(asMap, field)
			mutated, err := json.Marshal(asMap)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			result := validateRaw(t, schema, mutated)
			if result.Valid() {
				t.Fatalf("expected validation failure when %q is missing", field)
			}
			// Pinpoint the schema error so a future schema rewrite cannot
			// silently move the failure cause elsewhere.
			seen := false
			for _, e := range result.Errors() {
				if e.Field() == "(root)" && strings.Contains(e.Description(), field) {
					seen = true
				}
			}
			if !seen {
				var msgs []string
				for _, e := range result.Errors() {
					msgs = append(msgs, e.String())
				}
				t.Fatalf("expected error mentioning %q, got: %s", field, strings.Join(msgs, "; "))
			}
		})
	}
}

func TestSchema_RejectsBadMerchantRequestId(t *testing.T) {
	schema := loadSchema(t)
	r := validReceipt()
	r.MerchantRequestID = "too-short" // < 22 chars
	result := validateAgainstSchema(t, schema, r)
	if result.Valid() {
		t.Fatal("expected schema to reject merchantRequestId shorter than 22 chars")
	}
}

func TestSchema_RejectsNonCanonicalAmount(t *testing.T) {
	schema := loadSchema(t)
	r := validReceipt()
	r.Amount = "01.5" // leading zero — non-canonical
	if result := validateAgainstSchema(t, schema, r); result.Valid() {
		t.Fatal("expected schema to reject non-canonical amount with leading zero")
	}
	r.Amount = "1.5e1" // scientific notation
	if result := validateAgainstSchema(t, schema, r); result.Valid() {
		t.Fatal("expected schema to reject amount in scientific notation")
	}
	r.Amount = "1" // missing fractional component
	if result := validateAgainstSchema(t, schema, r); result.Valid() {
		t.Fatal("expected schema to reject amount without fractional component")
	}
}

func TestSchema_RejectsUnknownSignatureScheme(t *testing.T) {
	schema := loadSchema(t)
	r := validReceipt()
	r.SignatureScheme = "Ed25519ph"
	if result := validateAgainstSchema(t, schema, r); result.Valid() {
		t.Fatal("expected schema to reject signatureScheme != Ed25519")
	}
}

// ---------------------------------------------------------------------------
// Golden envelope tests (402, order, proof, error). Each fixture enumerates
// every round-3 field the wire shape MUST carry so a regression that drops
// one is caught here even before the consuming module wires it up.
// ---------------------------------------------------------------------------

const (
	envelope402  = "402_envelope"
	envelopeOrd  = "order_envelope"
	envelopeProf = "proof_envelope"
	envelopeErr  = "error_envelope"
)

func TestGoldenEnvelope_402Required(t *testing.T) {
	// 402 envelope, returned by the merchant (§5.3). MUST carry every field
	// the SDK consumers depend on, including the round-3 trustedIssuer and
	// merchantRequestId binders.
	envelope := map[string]any{
		"x402Version": 1,
		"accepts": []any{
			map[string]any{
				"scheme":            "canton-daml",
				"amount":            "1.5",
				"currency":          "USD-canton",
				"trustedIssuer":     "Issuer::1220abc",
				"payTo":             "Merchant::1220abc",
				"facilitator":       "http://localhost:8080",
				"resource":          "/resource",
				"merchantRequestId": "abcdef0123456789abcdef0123",
			},
		},
		"error": "payment_required",
	}
	assertEnvelopeKeys(t, envelope402, envelope, []string{"x402Version", "accepts", "error"})
	accepts := envelope["accepts"].([]any)[0].(map[string]any)
	assertEnvelopeKeys(t, envelope402+".accepts[0]", accepts, []string{
		"scheme", "amount", "currency", "trustedIssuer", "payTo",
		"facilitator", "resource", "merchantRequestId",
	})
}

func TestGoldenEnvelope_OrderRequired(t *testing.T) {
	// 201 order envelope, returned by the facilitator (§5.1). The accepts[]
	// entry carries the command payload the payer signs; every round-3 field
	// MUST appear inside command.{createArgs,choiceArgs,submissionPayloadHash,
	// expiresAtHttp, expiresAtDaml}.
	envelope := map[string]any{
		"x402Version":           1,
		"orderId":               "0190f7d2-1234-7890-abcd-1234567890ab",
		"nonce":                 "AAECAwQFBgcICQoLDA0ODw==",
		"status":                "CREATED",
		"submissionPayloadHash": "yQqDk+Hh9pMR7QY8FaC0e+vT0R8Hf3kJ0YwK0RsBb0M=",
		"accepts": []any{
			map[string]any{
				"scheme":            "canton-daml",
				"amount":            "1.5",
				"currency":          "USD-canton",
				"payTo":             "Merchant::1220abc",
				"resource":          "/resource",
				"expiresAt":         int64(1_715_600_000_000),
				"merchantRequestId": "abcdef0123456789abcdef0123",
				"command": map[string]any{
					"templateId": "Payment:PaymentRequest",
					"createArgs": map[string]any{
						"merchant":          "Merchant::1220abc",
						"payer":             "Payer::1220abc",
						"amount":            "1.5",
						"currency":          "USD-canton",
						"trustedIssuer":     "Issuer::1220abc",
						"expires":           int64(1_715_600_030_000),
						"memo":              "",
						"dedupKey":          "deadbeefcafe",
						"merchantRequestId": "abcdef0123456789abcdef0123",
					},
					"choice": "Pay",
					"choiceArgs": map[string]any{
						"sourceHolding": "00:Holding:source",
					},
					"dedupId":               "dGVzdC1kZWR1cC1pZA==",
					"submissionPayloadHash": "yQqDk+Hh9pMR7QY8FaC0e+vT0R8Hf3kJ0YwK0RsBb0M=",
					"expiresAtHttp":         int64(1_715_600_000_000),
					"expiresAtDaml":         int64(1_715_600_030_000),
				},
			},
		},
	}
	assertEnvelopeKeys(t, envelopeOrd, envelope, []string{
		"x402Version", "orderId", "nonce", "status", "submissionPayloadHash", "accepts",
	})
	accepts := envelope["accepts"].([]any)[0].(map[string]any)
	assertEnvelopeKeys(t, envelopeOrd+".accepts[0]", accepts, []string{
		"scheme", "amount", "currency", "payTo", "resource",
		"expiresAt", "merchantRequestId", "command",
	})
	cmd := accepts["command"].(map[string]any)
	assertEnvelopeKeys(t, envelopeOrd+".accepts[0].command", cmd, []string{
		"templateId", "createArgs", "choice", "choiceArgs",
		"dedupId", "submissionPayloadHash", "expiresAtHttp", "expiresAtDaml",
	})
	args := cmd["createArgs"].(map[string]any)
	assertEnvelopeKeys(t, envelopeOrd+".accepts[0].command.createArgs", args, []string{
		"merchant", "payer", "amount", "currency", "trustedIssuer",
		"expires", "memo", "dedupKey", "merchantRequestId",
	})
}

func TestGoldenEnvelope_ProofRequired(t *testing.T) {
	// Proof envelope === the receipt itself. Validate it against the public
	// JSON Schema AND assert it round-trips through Canonical() losslessly.
	schema := loadSchema(t)
	r := validReceipt()
	result := validateAgainstSchema(t, schema, r)
	if !result.Valid() {
		var msgs []string
		for _, e := range result.Errors() {
			msgs = append(msgs, e.String())
		}
		t.Fatalf("proof envelope must validate against schema: %s", strings.Join(msgs, "; "))
	}

	// Every round-3 field MUST be present in the JSON output.
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(raw, &asMap); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	required := []string{
		"version", "domain", "orderId", "ledgerId", "transactionId",
		"contractId", "paymentRequestContractId", "participantPartyId",
		"merchant", "payer", "amount", "currency", "trustedIssuer", "resource",
		"merchantRequestId", "expiresAtHttp", "expiresAtDaml",
		"signatureScheme", "signature", "receiptPayloadHash", "completedAt",
	}
	assertEnvelopeKeys(t, envelopeProf, asMap, required)
}

func TestGoldenEnvelope_ErrorRequired(t *testing.T) {
	// Error envelope is the §5.1 canonical error shape. Always-on fields are
	// `code` and `message`; SDKs key off `code`.
	envelope := map[string]any{
		"code":    "INVALID_INPUT",
		"message": "trustedIssuer mismatch",
	}
	assertEnvelopeKeys(t, envelopeErr, envelope, []string{"code", "message"})
}

func assertEnvelopeKeys(t *testing.T, label string, m map[string]any, required []string) {
	t.Helper()
	for _, k := range required {
		if _, ok := m[k]; !ok {
			t.Errorf("%s: missing required key %q", label, k)
		}
	}
}
