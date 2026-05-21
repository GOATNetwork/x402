package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/signer"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
)

// CustodialSignDeps carries the dependencies POST /custodial-sign needs.
type CustodialSignDeps struct {
	Store       store.OrderStore
	Signer      signer.Signer
	TokenStore  middleware.PayerTokenStore
	CantonProd  bool
	Now         func() time.Time
}

type custodialSignResponse struct {
	SignatureScheme string `json:"signatureScheme"`
	Signature       string `json:"signature"`
	PublicKey       string `json:"publicKey"`
}

// CustodialSignHandler returns the POST /api/v1/orders/:id/custodial-sign
// handler. In production it always returns 410 ENDPOINT_RETIRED; the route
// stays registered so SDKs see a deterministic status rather than a 404.
func CustodialSignHandler(d CustodialSignDeps) func(http.ResponseWriter, *http.Request, string) {
	if d.Now == nil {
		d.Now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request, orderID string) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		if d.CantonProd {
			writeErrorWithOrder(w, http.StatusGone, ErrEndpointRetired,
				"custodial-sign retired under CANTON_PROD=true", orderID)
			return
		}
		o, canonical, err := LoadCanonicalSubmissionFor(r.Context(), d.Store, orderID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErrorWithOrder(w, http.StatusNotFound, ErrOrderNotFound, "order not found", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load order", orderID)
			return
		}

		// Token binding.
		tok := r.Header.Get(middleware.HeaderXPayerToken)
		ok, code := middleware.AssertBoundToParty(tok, o.Payer, d.TokenStore)
		if !ok {
			status := http.StatusUnauthorized
			ec := ErrUnauthenticated
			if code == "PAYER_NOT_BOUND" {
				status = http.StatusForbidden
				ec = ErrPayerNotBound
			}
			writeErrorWithOrder(w, status, ec, "X-Payer-Token check failed", orderID)
			return
		}

		// State + expiry.
		if o.Status != store.StatusCreated {
			writeErrorWithOrder(w, http.StatusConflict, ErrInvalidState, "order not in CREATED", orderID)
			return
		}
		if d.Now().UnixMilli() > o.ExpiresAt {
			writeErrorWithOrder(w, http.StatusGone, ErrOrderExpired, "order expired", orderID)
			return
		}

		// Integrity diff: stored payload_hash must equal sha256(canonical).
		digest := sha256.Sum256(canonical)
		if !bytes.Equal(digest[:], o.PayloadHash) {
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrIntegrityFailure,
				"payload hash mismatch", orderID)
			return
		}

		sig, err := d.Signer.Sign(r.Context(), o.Payer, canonical)
		if err != nil {
			if errors.Is(err, signer.ErrPartyNotFound) {
				writeErrorWithOrder(w, http.StatusServiceUnavailable, ErrCustodialUnavailable,
					"no custodial key for payer", orderID)
				return
			}
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "sign", orderID)
			return
		}
		pub, err := d.Signer.PublicKey(o.Payer)
		if err != nil {
			writeErrorWithOrder(w, http.StatusInternalServerError, ErrInternal, "load public key", orderID)
			return
		}
		writeJSON(w, http.StatusOK, custodialSignResponse{
			SignatureScheme: sig.Scheme,
			Signature:       base64.StdEncoding.EncodeToString(sig.Bytes),
			PublicKey:       base64.StdEncoding.EncodeToString(pub),
		})
	}
}
