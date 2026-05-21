// Package receipt defines the public CantonReceipt type and its canonical
// serialiser. The package has zero network imports so the same code can be
// reused by the facilitator, the merchant verifier, and the demo clients.
package receipt

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"golang.org/x/text/unicode/norm"
)

// SchemaVersion is the current wire-format version of the receipt envelope.
const SchemaVersion = "1.0"

// DomainV1 is the v1 domain-separation tag included as an explicit prefix in
// the canonical bytes that the participant-operator key signs.
const DomainV1 = "goat-canton-receipt:v1"

// SignatureSchemeEd25519 is the only signature scheme accepted in v0.
const SignatureSchemeEd25519 = "Ed25519"

// CantonReceipt is the off-chain settlement artefact a merchant verifies. The
// JSON tags are the public wire shape; see docs/canton-receipt.schema.json.
type CantonReceipt struct {
	Version                  string `json:"version"`
	Domain                   string `json:"domain"`
	OrderID                  string `json:"orderId"`
	LedgerID                 string `json:"ledgerId"`
	TransactionID            string `json:"transactionId"`
	ContractID               string `json:"contractId"`
	PaymentRequestContractID string `json:"paymentRequestContractId"`
	ParticipantPartyID       string `json:"participantPartyId"`
	Merchant                 string `json:"merchant"`
	Payer                    string `json:"payer"`
	Amount                   string `json:"amount"`
	Currency                 string `json:"currency"`
	TrustedIssuer            string `json:"trustedIssuer"`
	Resource                 string `json:"resource"`
	MerchantRequestID        string `json:"merchantRequestId"`
	ExpiresAtHTTP            int64  `json:"expiresAtHttp"`
	ExpiresAtDaml            int64  `json:"expiresAtDaml"`
	SignatureScheme          string `json:"signatureScheme"`
	Signature                string `json:"signature"`
	ReceiptPayloadHash       string `json:"receiptPayloadHash"`
	CompletedAt              int64  `json:"completedAt"`
}

// ErrMissingDomain is returned when Canonical is asked to serialise a receipt
// whose Domain field is empty.
var ErrMissingDomain = errors.New("receipt: missing domain")

// canonicalSep is the single byte separating the domain prefix from the
// canonical JSON body. 0x00 is not valid inside JSON, so the boundary is
// unambiguous to anyone re-deriving the canonical bytes.
const canonicalSep byte = 0x00

// Canonical returns the deterministic bytes the participant-operator key
// signs. The signature and receiptPayloadHash fields are intentionally
// excluded from the preimage (PureEdDSA, signed over canonical bytes; the
// digest is display-only — see §6.4).
//
// Determinism contract: for any two structurally-equal CantonReceipts that
// agree on every field except Signature and ReceiptPayloadHash, Canonical
// returns byte-equal output. The output is `domain || 0x00 || canonicalJSON`
// where canonicalJSON has lexicographically-sorted keys and all string fields
// are NFC-normalised.
func (r CantonReceipt) Canonical() ([]byte, error) {
	if r.Domain == "" {
		return nil, ErrMissingDomain
	}
	domain := norm.NFC.String(r.Domain)

	fields := map[string]any{
		"version":                  norm.NFC.String(r.Version),
		"domain":                   domain,
		"orderId":                  norm.NFC.String(r.OrderID),
		"ledgerId":                 norm.NFC.String(r.LedgerID),
		"transactionId":            norm.NFC.String(r.TransactionID),
		"contractId":               norm.NFC.String(r.ContractID),
		"paymentRequestContractId": norm.NFC.String(r.PaymentRequestContractID),
		"participantPartyId":       norm.NFC.String(r.ParticipantPartyID),
		"merchant":                 norm.NFC.String(r.Merchant),
		"payer":                    norm.NFC.String(r.Payer),
		"amount":                   norm.NFC.String(r.Amount),
		"currency":                 norm.NFC.String(r.Currency),
		"trustedIssuer":            norm.NFC.String(r.TrustedIssuer),
		"resource":                 norm.NFC.String(r.Resource),
		"merchantRequestId":        norm.NFC.String(r.MerchantRequestID),
		"expiresAtHttp":            r.ExpiresAtHTTP,
		"expiresAtDaml":            r.ExpiresAtDaml,
		"signatureScheme":          norm.NFC.String(r.SignatureScheme),
		"completedAt":              r.CompletedAt,
	}

	body, err := marshalSortedJSON(fields)
	if err != nil {
		return nil, fmt.Errorf("receipt: marshal canonical body: %w", err)
	}

	out := make([]byte, 0, len(domain)+1+len(body))
	out = append(out, domain...)
	out = append(out, canonicalSep)
	out = append(out, body...)
	return out, nil
}

// marshalSortedJSON encodes m as JSON with lexicographically-sorted keys.
// Go's encoding/json sorts map[string]any keys already, but we re-implement
// the walk so nested maps and slices are sorted deterministically and we
// surface clear errors on unsupported value kinds.
func marshalSortedJSON(m map[string]any) ([]byte, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	buf := make([]byte, 0, 256)
	buf = append(buf, '{')
	for i, k := range keys {
		if i > 0 {
			buf = append(buf, ',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf = append(buf, kb...)
		buf = append(buf, ':')

		vb, err := marshalSortedValue(m[k])
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", k, err)
		}
		buf = append(buf, vb...)
	}
	buf = append(buf, '}')
	return buf, nil
}

func marshalSortedValue(v any) ([]byte, error) {
	switch x := v.(type) {
	case map[string]any:
		return marshalSortedJSON(x)
	case []any:
		buf := make([]byte, 0, 32)
		buf = append(buf, '[')
		for i, item := range x {
			if i > 0 {
				buf = append(buf, ',')
			}
			ib, err := marshalSortedValue(item)
			if err != nil {
				return nil, err
			}
			buf = append(buf, ib...)
		}
		buf = append(buf, ']')
		return buf, nil
	case string:
		return json.Marshal(x)
	case int64:
		return []byte(strconv.FormatInt(x, 10)), nil
	case int:
		return []byte(strconv.FormatInt(int64(x), 10)), nil
	case bool:
		if x {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case nil:
		return []byte("null"), nil
	default:
		return nil, fmt.Errorf("unsupported canonical value kind: %T", v)
	}
}
