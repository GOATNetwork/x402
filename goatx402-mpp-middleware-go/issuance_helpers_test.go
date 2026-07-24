package mppmiddleware

// Test-only issuance helpers.
//
// The receiptspec copy bundled with this public module is deliberately
// verification-side only — it does not export signing or receipt-id
// derivation APIs. The tests still need a platform-side issuer to
// produce fixtures, so the issuance constructions are replicated here.
// They MUST stay byte-compatible with the platform issuer (the
// standalone goatflow-mpp-receipt-spec module):
// TestVerify_CrossValidation_HelpersFromReceiptSpec and the golden
// fixture in receiptspec/sign_golden_test.go pin this.

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"

	receiptspec "github.com/goatnetwork/goatflow-mpp-middleware-go/receiptspec"
)

// testSignEd25519 mirrors the platform issuer: ed25519 over the
// SHA-256 of the canonical signing bytes (the domain-separation
// construction verified by receiptspec.VerifyEd25519).
func testSignEd25519(priv ed25519.PrivateKey, r receiptspec.Receipt) []byte {
	sum := sha256.Sum256(receiptspec.SigningBytes(r))
	return ed25519.Sign(priv, sum[:])
}

// testSignHMAC mirrors the platform issuer: HMAC-SHA256 over the
// canonical signing bytes (the construction verified by
// receiptspec.VerifyHMAC).
func testSignHMAC(secret []byte, r receiptspec.Receipt) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(receiptspec.SigningBytes(r))
	return mac.Sum(nil)
}

// testDeriveReceiptID mirrors the platform issuer's deterministic
// receipt-identifier derivation:
//
//	base64url( SHA-256( challenge_id || order_id || tx_hash || log_index_be8 )[:16] )
func testDeriveReceiptID(challengeID, orderID, txHash string, logIndex uint) string {
	h := sha256.New()
	h.Write([]byte(challengeID))
	h.Write([]byte(orderID))
	h.Write([]byte(txHash))
	var li [8]byte
	binary.BigEndian.PutUint64(li[:], uint64(logIndex))
	h.Write(li[:])
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:16])
}
