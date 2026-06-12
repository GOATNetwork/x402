package receiptspec

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
)

// DeriveReceiptID computes the deterministic receipt identifier:
//
//	base64url( SHA-256( challenge_id || order_id || tx_hash || log_index_be8 )[:16] )
//
// where || denotes raw byte concatenation, log_index_be8 is the 8-byte
// big-endian encoding of the 64-bit unsigned log index, and the leading
// 16 bytes (128 bits) of the SHA-256 digest are encoded with
// base64.RawURLEncoding (no padding, URL-safe alphabet, fixed length of
// 22 characters).
//
// Determinism guarantees:
//
//   - Identical inputs ALWAYS produce identical output across processes,
//     hosts, and language implementations that follow this spec.
//   - The truncation to 16 bytes is intentional: a 128-bit identifier is
//     short enough for log indices and URL paths while remaining
//     collision-resistant for the (challenge_id, order_id, tx_hash,
//     log_index) tuple space.
//
// This determinism is what makes lost-response recovery safe: if x402d
// settles a payment, crashes before delivering the receipt to the buyer,
// and is queried again, it will re-derive the SAME receipt_id and the
// merchant can safely treat duplicates as idempotent.
//
// Inputs are NOT validated for emptiness or encoding; pass canonical
// values. In particular, tx_hash should be a single canonical case (the
// MPP spec uses lower-cased hex with 0x prefix for EVM chains).
func DeriveReceiptID(challengeID, orderID, txHash string, logIndex uint) string {
	h := sha256.New()
	h.Write([]byte(challengeID))
	h.Write([]byte(orderID))
	h.Write([]byte(txHash))
	var liBytes [8]byte
	binary.BigEndian.PutUint64(liBytes[:], uint64(logIndex))
	h.Write(liBytes[:])
	sum := h.Sum(nil)[:16]
	return base64.RawURLEncoding.EncodeToString(sum)
}
