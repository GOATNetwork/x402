package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
	"golang.org/x/text/unicode/norm"
)

// supportedX402Version is the singleton wire-version we accept; advertised
// via X-X402-Supported-Versions per §5.1 / §5.5.
const supportedX402Version = 1

// merchantRequestIDRe enforces the §5.1 charset/length.
var merchantRequestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{22,64}$`)

// clientRequestIDRe enforces the optional §5.1 idempotency key.
var clientRequestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// amountRe is the strict normalised-decimal regex per §6.4 normalisation.
// We additionally enforce integer-side digit cap (≤ 28) and fractional cap
// (≤ 10) inside normaliseAmount because regex backreferences would complicate
// the pattern.
var amountRe = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?$`)

const (
	maxMemoBytes      = 256
	maxExpiresIn      = 600
	defaultExpiresIn  = 120
	maxIntegerDigits  = 28
	maxFractionalDigits = 10
)

// createOrderRequest mirrors §5.1 POST /api/v1/orders body. Fields are
// validated and normalised at handler entry; bad shapes return 400 before
// any persistence work.
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
	Memo                    string `json:"memo"`
	ExpiresIn               int    `json:"expiresIn"`
	ClientRequestID         string `json:"clientRequestId"`
}

// createOrderResponse mirrors §5.1 201 envelope.
type createOrderResponse struct {
	X402Version           int                `json:"x402Version"`
	OrderID               string             `json:"orderId"`
	Nonce                 string             `json:"nonce"`
	Status                string             `json:"status"`
	SubmissionPayloadHash string             `json:"submissionPayloadHash"`
	Accepts               []acceptEntry      `json:"accepts"`
}

type acceptEntry struct {
	Scheme            string       `json:"scheme"`
	Amount            string       `json:"amount"`
	Currency          string       `json:"currency"`
	PayTo             string       `json:"payTo"`
	Resource          string       `json:"resource"`
	ExpiresAt         int64        `json:"expiresAt"`
	MerchantRequestID string       `json:"merchantRequestId"`
	TrustedIssuer     string       `json:"trustedIssuer"`
	Command           commandShape `json:"command"`
}

type commandShape struct {
	TemplateID            string         `json:"templateId"`
	CreateArgs            map[string]any `json:"createArgs"`
	Choice                string         `json:"choice"`
	ChoiceArgs            map[string]any `json:"choiceArgs"`
	DedupID               string         `json:"dedupId"`
	SubmissionPayloadHash string         `json:"submissionPayloadHash"`
	ExpiresAtHTTP         int64          `json:"expiresAtHttp"`
	ExpiresAtDaml         int64          `json:"expiresAtDaml"`
}

// CreateOrderDeps is the dependency bundle for the POST /orders handler.
type CreateOrderDeps struct {
	Store               store.OrderStore
	TokenStore          middleware.PayerTokenStore
	CurrencyAllowList   map[string]struct{}
	TrustedIssuerMap    map[string]string
	LedgerSkewSafety    time.Duration
	X402SupportedVersions []int
	Now                 func() time.Time
	NewUUID             func() string
	NewNonce            func() string
}

// CreateOrderHandler returns the POST /api/v1/orders handler.
func CreateOrderHandler(d CreateOrderDeps) http.HandlerFunc {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewUUID == nil {
		d.NewUUID = newUUIDv4
	}
	if d.NewNonce == nil {
		d.NewNonce = newRandBase64
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		w.Header().Set(middleware.HeaderX402SupportedVersions, joinIntsCSV(d.X402SupportedVersions))

		var req createOrderRequest
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			// MaxBytesReader surfaces "http: request body too large" → map to
			// 413 (the BodyLimit middleware catches the ContentLength path;
			// chunked or unsized bodies surface here).
			if strings.Contains(err.Error(), "request body too large") {
				writeError(w, http.StatusRequestEntityTooLarge, ErrPayloadTooLarge, "body exceeds limit")
				return
			}
			writeError(w, http.StatusBadRequest, ErrInvalidInput, "malformed request body")
			return
		}

		// X-X402-Supported-Versions negotiation.
		if !intInSlice(req.X402Version, d.X402SupportedVersions) {
			writeError(w, http.StatusBadRequest, ErrInvalidInput, "unsupported x402Version")
			return
		}

		// Field-level validation.
		if err := validateCreateOrder(&req, d); err != nil {
			writeError(w, http.StatusBadRequest, ErrInvalidInput, err.Error())
			return
		}

		// Token binding to the payer in the body.
		tok := r.Header.Get(middleware.HeaderXPayerToken)
		ok, code := middleware.AssertBoundToParty(tok, req.Payer, d.TokenStore)
		if !ok {
			status := http.StatusUnauthorized
			ec := ErrUnauthenticated
			if code == "PAYER_NOT_BOUND" {
				status = http.StatusForbidden
				ec = ErrPayerNotBound
			}
			writeError(w, status, ec, "X-Payer-Token check failed")
			return
		}

		// Compute time fields, nonce, orderId.
		now := d.Now().UTC()
		orderID := d.NewUUID()
		nonce := d.NewNonce()
		expiresAtHTTP := now.Add(time.Duration(req.ExpiresIn) * time.Second).UnixMilli()
		expiresAtDaml := expiresAtHTTP + d.LedgerSkewSafety.Milliseconds()

		// Canonical dedup input + payload bytes.
		dedupBytes, err := CanonicalDedupInput(DedupInput{
			Payer:                   req.Payer,
			Merchant:                req.Merchant,
			Amount:                  req.Amount,
			Currency:                req.Currency,
			TrustedIssuer:           req.TrustedIssuer,
			ExpiresAtHTTP:           expiresAtHTTP,
			Resource:                req.Resource,
			SourceHoldingContractID: req.SourceHoldingContractID,
			MerchantRequestID:       req.MerchantRequestID,
			OrderID:                 orderID,
			Nonce:                   nonce,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, ErrInternal, "canonical dedup input")
			return
		}
		dedupDigest := sha256.Sum256(dedupBytes)
		dedupID := base64.StdEncoding.EncodeToString(dedupDigest[:])
		dedupKey := hex.EncodeToString(dedupDigest[:])

		submissionBytes, err := CanonicalSubmission(SignInput{
			Payer:                   req.Payer,
			Merchant:                req.Merchant,
			Amount:                  req.Amount,
			Currency:                req.Currency,
			TrustedIssuer:           req.TrustedIssuer,
			ExpiresAtHTTP:           expiresAtHTTP,
			Resource:                req.Resource,
			SourceHoldingContractID: req.SourceHoldingContractID,
			MerchantRequestID:       req.MerchantRequestID,
			OrderID:                 orderID,
			Nonce:                   nonce,
			DedupKey:                dedupKey,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, ErrInternal, "canonical submission")
			return
		}
		payloadHashRaw := sha256.Sum256(submissionBytes)
		submissionPayloadHash := base64.StdEncoding.EncodeToString(payloadHashRaw[:])

		// Idempotency: try fingerprint match if clientRequestId is present.
		var fingerprint []byte
		if req.ClientRequestID != "" {
			fp, err := CanonicalRequestFingerprint(RequestFingerprintInput{
				Merchant:                req.Merchant,
				Amount:                  req.Amount,
				Currency:                req.Currency,
				TrustedIssuer:           req.TrustedIssuer,
				Resource:                req.Resource,
				SourceHoldingContractID: req.SourceHoldingContractID,
				MerchantRequestID:       req.MerchantRequestID,
				Memo:                    req.Memo,
				ExpiresIn:               req.ExpiresIn,
			})
			if err != nil {
				writeError(w, http.StatusInternalServerError, ErrInternal, "canonical fingerprint")
				return
			}
			h := sha256.Sum256(fp)
			fingerprint = h[:]
		}

		var memoPtr *string
		if req.Memo != "" {
			memoPtr = &req.Memo
		}
		var clientReqPtr *string
		if req.ClientRequestID != "" {
			clientReqPtr = &req.ClientRequestID
		}

		o := store.Order{
			ID:                      orderID,
			Status:                  store.StatusCreated,
			Amount:                  req.Amount,
			Currency:                req.Currency,
			TrustedIssuer:           req.TrustedIssuer,
			Merchant:                req.Merchant,
			Payer:                   req.Payer,
			Resource:                req.Resource,
			Nonce:                   nonce,
			Memo:                    memoPtr,
			ExpiresAt:               expiresAtHTTP,
			DedupID:                 dedupID,
			PayloadHash:             payloadHashRaw[:],
			MerchantRequestID:       req.MerchantRequestID,
			ClientRequestID:         clientReqPtr,
			RequestFingerprint:      fingerprint,
			SourceHoldingContractID: req.SourceHoldingContractID,
			CreatedAt:               now.UnixMilli(),
			UpdatedAt:               now.UnixMilli(),
		}
		if err := d.Store.Create(r.Context(), o); err != nil {
			if errors.Is(err, store.ErrDuplicate) {
				// Distinguish dedup_id collision from (payer, clientRequestId)
				// idempotency. The (payer, clientRequestId) path is handled
				// via a follow-up GET — the store does not surface which
				// UNIQUE fired, so we run a follow-up lookup ourselves.
				if req.ClientRequestID != "" {
					// TODO(task-9): a store.LookupByClientRequest helper would
					// let us project the original orderId here. For now,
					// surface the canonical 409 DUPLICATE_CLIENT_REQUEST and
					// let the client retry with a fresh key.
					writeError(w, http.StatusConflict, ErrDuplicateClientReq, "client request already exists")
					return
				}
				writeError(w, http.StatusConflict, ErrDuplicateDedup, "duplicate dedup id")
				return
			}
			writeError(w, http.StatusInternalServerError, ErrInternal, "create order")
			return
		}

		resp := createOrderResponse{
			X402Version:           supportedX402Version,
			OrderID:               orderID,
			Nonce:                 nonce,
			Status:                string(store.StatusCreated),
			SubmissionPayloadHash: submissionPayloadHash,
			Accepts: []acceptEntry{{
				Scheme:            "canton-daml",
				Amount:            req.Amount,
				Currency:          req.Currency,
				PayTo:             req.Merchant,
				Resource:          req.Resource,
				ExpiresAt:         expiresAtHTTP,
				MerchantRequestID: req.MerchantRequestID,
				TrustedIssuer:     req.TrustedIssuer,
				Command: commandShape{
					TemplateID: "Payment:PaymentRequest",
					CreateArgs: map[string]any{
						"merchant":          req.Merchant,
						"payer":             req.Payer,
						"amount":            req.Amount,
						"currency":          req.Currency,
						"trustedIssuer":     req.TrustedIssuer,
						"expires":           expiresAtDaml,
						"memo":              req.Memo,
						"dedupKey":          dedupKey,
						"merchantRequestId": req.MerchantRequestID,
					},
					Choice: "Pay",
					ChoiceArgs: map[string]any{
						"sourceHolding": req.SourceHoldingContractID,
					},
					DedupID:               dedupID,
					SubmissionPayloadHash: submissionPayloadHash,
					ExpiresAtHTTP:         expiresAtHTTP,
					ExpiresAtDaml:         expiresAtDaml,
				},
			}},
		}
		writeJSON(w, http.StatusCreated, resp)
	}
}

func validateCreateOrder(req *createOrderRequest, d CreateOrderDeps) error {
	if req.Merchant == "" {
		return errors.New("merchant required")
	}
	if req.Payer == "" {
		return errors.New("payer required")
	}
	if req.Currency == "" {
		return errors.New("currency required")
	}
	if _, ok := d.CurrencyAllowList[req.Currency]; !ok {
		return fmt.Errorf("currency %q not in allowlist", req.Currency)
	}
	if req.TrustedIssuer == "" {
		return errors.New("trustedIssuer required")
	}
	if want := d.TrustedIssuerMap[req.Currency]; want != req.TrustedIssuer {
		return fmt.Errorf("trustedIssuer mismatch for currency %s", req.Currency)
	}
	if req.Resource == "" {
		return errors.New("resource required")
	}
	if req.SourceHoldingContractID == "" {
		return errors.New("sourceHoldingContractId required")
	}
	if !merchantRequestIDRe.MatchString(req.MerchantRequestID) {
		return errors.New("merchantRequestId malformed")
	}
	if req.ClientRequestID != "" && !clientRequestIDRe.MatchString(req.ClientRequestID) {
		return errors.New("clientRequestId malformed")
	}
	normalised, err := NormaliseAmount(req.Amount)
	if err != nil {
		return fmt.Errorf("amount: %v", err)
	}
	req.Amount = normalised
	if len(req.Memo) > maxMemoBytes {
		// NFC-normalise + truncate at byte boundary.
		req.Memo = TruncateMemo(req.Memo)
	}
	if req.ExpiresIn == 0 {
		req.ExpiresIn = defaultExpiresIn
	}
	if req.ExpiresIn < 0 || req.ExpiresIn > maxExpiresIn {
		return fmt.Errorf("expiresIn out of range: %d", req.ExpiresIn)
	}
	return nil
}

// NormaliseAmount enforces the §6.4 canonical decimal-string form. Returns the
// canonical string or an error on rejection. Exported so tests and the canton
// submitter can re-use the same path.
func NormaliseAmount(s string) (string, error) {
	if s == "" {
		return "", errors.New("empty")
	}
	if !amountRe.MatchString(s) {
		return "", fmt.Errorf("%q not a canonical decimal", s)
	}
	intPart := s
	fracPart := ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart = s[:i]
		fracPart = s[i+1:]
	}
	if len(intPart) > maxIntegerDigits {
		return "", fmt.Errorf("integer-side %d digits exceeds %d", len(intPart), maxIntegerDigits)
	}
	if len(fracPart) > maxFractionalDigits {
		return "", fmt.Errorf("fractional %d digits exceeds %d", len(fracPart), maxFractionalDigits)
	}
	// Trim trailing zeros from fractional part; if all zeros / empty, use ".0".
	for len(fracPart) > 0 && fracPart[len(fracPart)-1] == '0' {
		fracPart = fracPart[:len(fracPart)-1]
	}
	if fracPart == "" {
		fracPart = "0"
	}
	// Reject leading zeros on the integer side: amountRe ensures the only
	// allowed leading-zero form is "0".
	if intPart == "" {
		intPart = "0"
	}
	// Disallow "-0.0" via the strict regex (already covered).
	out := intPart + "." + fracPart
	// Final sanity check.
	if out == "0.0" {
		return "", errors.New("amount must be > 0")
	}
	return out, nil
}

// TruncateMemo NFC-normalises memo and truncates at the largest UTF-8-safe
// byte boundary ≤ maxMemoBytes. Exported so client-side helpers can mirror
// the same logic in tests.
func TruncateMemo(memo string) string {
	nfc := norm.NFC.String(memo)
	if len(nfc) <= maxMemoBytes {
		return nfc
	}
	cut := maxMemoBytes
	for cut > 0 && !utf8StartByte(nfc[cut]) {
		cut--
	}
	return nfc[:cut]
}

func utf8StartByte(b byte) bool { return b&0xC0 != 0x80 }

// ---------------------------------------------------------------------------
// Canonical functions — duplicated locally because pkg/receipt does not yet
// export them (Task 4 only ships CantonReceipt.Canonical). They follow the
// same lexicographic-key-sort + UTF-8 NFC discipline as CantonReceipt.Canonical,
// with a domain-separation prefix so the submission and dedup-input preimages
// can never alias the receipt preimage.
//
// TODO(task-4-followup): hoist these into pkg/receipt as CanonicalSubmission /
// CanonicalDedupInput / CanonicalRequestFingerprint exports so the CLI and
// browser clients consume the same code path.
// ---------------------------------------------------------------------------

// CanonicalSubmissionDomain is the domain-separation prefix on the bytes the
// payer signs at /calldata-signature.
const CanonicalSubmissionDomain = "goat-canton-submission:v1"

// CanonicalDedupDomain is the prefix on the preimage that yields dedup_id /
// dedupKey.
const CanonicalDedupDomain = "goat-canton-dedup:v1"

// CanonicalFingerprintDomain is the prefix on the (payer, clientRequestId)
// idempotency-fingerprint preimage.
const CanonicalFingerprintDomain = "goat-canton-fingerprint:v1"

// DedupInput is the field bundle for CanonicalDedupInput. The bytes it
// produces are the preimage for dedup_id (base64) and dedupKey (hex).
type DedupInput struct {
	Payer                   string
	Merchant                string
	Amount                  string
	Currency                string
	TrustedIssuer           string
	ExpiresAtHTTP           int64
	Resource                string
	SourceHoldingContractID string
	MerchantRequestID       string
	OrderID                 string
	Nonce                   string
}

// CanonicalDedupInput returns the bytes hashed for dedup_id. Excludes
// dedupKey (which is itself derived from this hash; PLAN.md §6.4).
func CanonicalDedupInput(in DedupInput) ([]byte, error) {
	fields := map[string]any{
		"payer":                   norm.NFC.String(in.Payer),
		"merchant":                norm.NFC.String(in.Merchant),
		"amount":                  norm.NFC.String(in.Amount),
		"currency":                norm.NFC.String(in.Currency),
		"trustedIssuer":           norm.NFC.String(in.TrustedIssuer),
		"expiresAtHttp":           in.ExpiresAtHTTP,
		"resource":                norm.NFC.String(in.Resource),
		"sourceHoldingContractId": norm.NFC.String(in.SourceHoldingContractID),
		"merchantRequestId":       norm.NFC.String(in.MerchantRequestID),
		"orderId":                 norm.NFC.String(in.OrderID),
		"nonce":                   norm.NFC.String(in.Nonce),
	}
	return wrapCanonical(CanonicalDedupDomain, fields)
}

// SignInput is the field bundle for CanonicalSubmission. Includes dedupKey so
// the payer's signature commits to the exact ledger template-key value.
type SignInput struct {
	Payer                   string
	Merchant                string
	Amount                  string
	Currency                string
	TrustedIssuer           string
	ExpiresAtHTTP           int64
	Resource                string
	SourceHoldingContractID string
	MerchantRequestID       string
	OrderID                 string
	Nonce                   string
	DedupKey                string
}

// CanonicalSubmission returns the bytes the payer signs at /calldata-signature.
func CanonicalSubmission(in SignInput) ([]byte, error) {
	fields := map[string]any{
		"payer":                   norm.NFC.String(in.Payer),
		"merchant":                norm.NFC.String(in.Merchant),
		"amount":                  norm.NFC.String(in.Amount),
		"currency":                norm.NFC.String(in.Currency),
		"trustedIssuer":           norm.NFC.String(in.TrustedIssuer),
		"expiresAtHttp":           in.ExpiresAtHTTP,
		"resource":                norm.NFC.String(in.Resource),
		"sourceHoldingContractId": norm.NFC.String(in.SourceHoldingContractID),
		"merchantRequestId":       norm.NFC.String(in.MerchantRequestID),
		"orderId":                 norm.NFC.String(in.OrderID),
		"nonce":                   norm.NFC.String(in.Nonce),
		"dedupKey":                norm.NFC.String(in.DedupKey),
	}
	return wrapCanonical(CanonicalSubmissionDomain, fields)
}

// RequestFingerprintInput is the field bundle for
// CanonicalRequestFingerprint. Excludes payer + clientRequestId per §4.2
// (those are the lookup keys; including them would let identical bodies
// self-match).
type RequestFingerprintInput struct {
	Merchant                string
	Amount                  string
	Currency                string
	TrustedIssuer           string
	Resource                string
	SourceHoldingContractID string
	MerchantRequestID       string
	Memo                    string
	ExpiresIn               int
}

// CanonicalRequestFingerprint returns the bytes hashed for request_fingerprint.
func CanonicalRequestFingerprint(in RequestFingerprintInput) ([]byte, error) {
	fields := map[string]any{
		"merchant":                norm.NFC.String(in.Merchant),
		"amount":                  norm.NFC.String(in.Amount),
		"currency":                norm.NFC.String(in.Currency),
		"trustedIssuer":           norm.NFC.String(in.TrustedIssuer),
		"resource":                norm.NFC.String(in.Resource),
		"sourceHoldingContractId": norm.NFC.String(in.SourceHoldingContractID),
		"merchantRequestId":       norm.NFC.String(in.MerchantRequestID),
		"memo":                    norm.NFC.String(in.Memo),
		"expiresIn":               int64(in.ExpiresIn),
	}
	return wrapCanonical(CanonicalFingerprintDomain, fields)
}

func wrapCanonical(domain string, fields map[string]any) ([]byte, error) {
	body, err := marshalSortedJSON(fields)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(domain)+1+len(body))
	out = append(out, domain...)
	out = append(out, 0x00)
	out = append(out, body...)
	return out, nil
}

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
		v := m[k]
		switch x := v.(type) {
		case string:
			vb, err := json.Marshal(x)
			if err != nil {
				return nil, err
			}
			buf = append(buf, vb...)
		case int64:
			buf = append(buf, []byte(fmt.Sprintf("%d", x))...)
		default:
			vb, err := json.Marshal(x)
			if err != nil {
				return nil, err
			}
			buf = append(buf, vb...)
		}
	}
	buf = append(buf, '}')
	return buf, nil
}

// ---- random helpers ----

func newUUIDv4() string {
	// crypto/rand-backed lower-cased UUID v4 in canonical 8-4-4-4-12 form.
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const hexd = "0123456789abcdef"
	hexBuf := make([]byte, 32)
	for i, by := range b {
		hexBuf[i*2] = hexd[by>>4]
		hexBuf[i*2+1] = hexd[by&0x0f]
	}
	return string(hexBuf[0:8]) + "-" + string(hexBuf[8:12]) + "-" + string(hexBuf[12:16]) + "-" + string(hexBuf[16:20]) + "-" + string(hexBuf[20:32])
}

func newRandBase64() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.StdEncoding.EncodeToString(b[:])
}

func joinIntsCSV(xs []int) string {
	if len(xs) == 0 {
		return ""
	}
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = fmt.Sprintf("%d", x)
	}
	return strings.Join(parts, ",")
}

func intInSlice(n int, xs []int) bool {
	for _, x := range xs {
		if x == n {
			return true
		}
	}
	return false
}

// LoadCanonicalSubmissionFor recomputes the canonical submission bytes for
// the stored order. /custodial-sign and /calldata-signature use this both to
// reconstruct the signing target and to run the integrity diff against
// orders.payload_hash (PLAN.md §6.6 integrity-diff invariant).
func LoadCanonicalSubmissionFor(ctx context.Context, s store.OrderStore, orderID string) (store.Order, []byte, error) {
	o, err := s.Get(ctx, orderID)
	if err != nil {
		return store.Order{}, nil, err
	}
	dedupBytes, err := CanonicalDedupInput(DedupInput{
		Payer:                   o.Payer,
		Merchant:                o.Merchant,
		Amount:                  o.Amount,
		Currency:                o.Currency,
		TrustedIssuer:           o.TrustedIssuer,
		ExpiresAtHTTP:           o.ExpiresAt,
		Resource:                o.Resource,
		SourceHoldingContractID: o.SourceHoldingContractID,
		MerchantRequestID:       o.MerchantRequestID,
		OrderID:                 o.ID,
		Nonce:                   o.Nonce,
	})
	if err != nil {
		return o, nil, err
	}
	dedupDigest := sha256.Sum256(dedupBytes)
	dedupKey := hex.EncodeToString(dedupDigest[:])
	canonical, err := CanonicalSubmission(SignInput{
		Payer:                   o.Payer,
		Merchant:                o.Merchant,
		Amount:                  o.Amount,
		Currency:                o.Currency,
		TrustedIssuer:           o.TrustedIssuer,
		ExpiresAtHTTP:           o.ExpiresAt,
		Resource:                o.Resource,
		SourceHoldingContractID: o.SourceHoldingContractID,
		MerchantRequestID:       o.MerchantRequestID,
		OrderID:                 o.ID,
		Nonce:                   o.Nonce,
		DedupKey:                dedupKey,
	})
	return o, canonical, err
}
