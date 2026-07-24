package receiptspec

import (
	"errors"
	"fmt"
	"math/big"
	"time"
)

// Receipt is the value object that x402d signs and merchant middleware
// verifies. It captures a single settled payment in a way that is both
// human-debuggable (JSON-friendly tags) and machine-canonicalizable (see
// signingBytes in sign.go).
//
// The order of binding fields below is part of the on-wire contract: the
// signing-bytes layout in sign.go follows this exact order, and changing
// the order without bumping the protocol version will break every
// deployed verifier. Do NOT reorder, insert, or remove fields without a
// version bump.
//
// Field semantics:
//
//   - ReceiptID: deterministic identifier derived by the issuing
//     platform per the MPP receipt spec. Used by merchants for
//     idempotent receipt storage and lost-response recovery.
//   - ChallengeID: the MPP challenge nonce the buyer redeemed.
//   - OrderID: x402d order identifier this receipt finalizes.
//   - MerchantID: opaque merchant identifier; scopes the receipt so a
//     receipt for merchant A cannot be replayed at merchant B.
//   - PayerAddr: the on-chain payer address (EVM hex or chain-native
//     encoding; this module is encoding-agnostic).
//   - ChainID: numeric chain identifier (EVM chainID, Solana cluster
//     code, ...).
//   - TokenContract: token contract address (or chain-native equivalent)
//     of the asset paid in.
//   - Recipient: on-chain address that actually received the funds.
//   - AmountWei: amount in smallest indivisible units as a base-10
//     decimal string. Avoids float / precision pitfalls across languages.
//     Validate() checks that this parses as a non-negative big.Int.
//   - RequestCanonical: the canonicalized payment request the buyer
//     attested to. Defined by the higher-level MPP spec; this module
//     treats it as an opaque string but includes it in the signature so
//     the merchant can re-derive it and compare.
//   - TxHash: on-chain transaction hash where the settlement event was
//     observed.
//   - LogIndex: index of the relevant log within TxHash. Combined with
//     TxHash this uniquely pins a settlement event.
//   - BlockNumber: settlement block height.
//   - BlockTimestamp: settlement block timestamp (chain-reported,
//     deterministic — NOT wall clock).
//   - ReceiptIssuedAt: when the receipt was issued. By MPP convention
//     this equals BlockTimestamp so that re-issuing on a lost response
//     yields a byte-identical receipt.
//   - ReceiptExpiresAt: when verifiers should refuse the receipt.
//     Validate() enforces ReceiptExpiresAt > ReceiptIssuedAt.
type Receipt struct {
	ReceiptID        string    `json:"receipt_id"`
	ChallengeID      string    `json:"challenge_id"`
	OrderID          string    `json:"order_id"`
	MerchantID       string    `json:"merchant_id"`
	PayerAddr        string    `json:"payer_addr"`
	ChainID          int64     `json:"chain_id"`
	TokenContract    string    `json:"token_contract"`
	Recipient        string    `json:"recipient"`
	AmountWei        string    `json:"amount_wei"`
	RequestCanonical string    `json:"request_canonical"`
	TxHash           string    `json:"tx_hash"`
	LogIndex         uint      `json:"log_index"`
	BlockNumber      int64     `json:"block_number"`
	BlockTimestamp   time.Time `json:"block_timestamp"`
	ReceiptIssuedAt  time.Time `json:"receipt_issued_at"`
	ReceiptExpiresAt time.Time `json:"receipt_expires_at"`
}

// ErrInvalidReceipt is returned (wrapped) by Receipt.Validate when the
// receipt fails structural validation. The wrapped message identifies
// which field failed; callers SHOULD log the wrapped error and return a
// generic error to the caller to avoid leaking internal state.
var ErrInvalidReceipt = errors.New("receiptspec: invalid receipt")

// Validate performs structural validation on a Receipt. It enforces:
//
//   - All required string fields are non-empty.
//   - ChainID is non-negative (zero is allowed only as an explicit
//     "unset" sentinel — callers should treat zero with care).
//   - AmountWei parses as a non-negative base-10 big.Int.
//   - BlockNumber is non-negative.
//   - BlockTimestamp, ReceiptIssuedAt, ReceiptExpiresAt are all non-zero.
//   - ReceiptExpiresAt strictly after ReceiptIssuedAt.
//
// Validate does NOT verify the signature; use VerifyEd25519 / VerifyHMAC
// for that. It also does NOT check that ReceiptID matches the
// deterministic derivation — callers that need that check should
// re-derive the identifier per the MPP receipt spec and compare
// explicitly (constant-time comparison is
// only required when comparing untrusted receipt_ids in a security
// boundary; see constantTimeEqual).
func (r Receipt) Validate() error {
	if r.ReceiptID == "" {
		return fmt.Errorf("%w: receipt_id is empty", ErrInvalidReceipt)
	}
	if r.ChallengeID == "" {
		return fmt.Errorf("%w: challenge_id is empty", ErrInvalidReceipt)
	}
	if r.OrderID == "" {
		return fmt.Errorf("%w: order_id is empty", ErrInvalidReceipt)
	}
	if r.MerchantID == "" {
		return fmt.Errorf("%w: merchant_id is empty", ErrInvalidReceipt)
	}
	if r.PayerAddr == "" {
		return fmt.Errorf("%w: payer_addr is empty", ErrInvalidReceipt)
	}
	if r.ChainID < 0 {
		return fmt.Errorf("%w: chain_id is negative", ErrInvalidReceipt)
	}
	if r.TokenContract == "" {
		return fmt.Errorf("%w: token_contract is empty", ErrInvalidReceipt)
	}
	if r.Recipient == "" {
		return fmt.Errorf("%w: recipient is empty", ErrInvalidReceipt)
	}
	if r.AmountWei == "" {
		return fmt.Errorf("%w: amount_wei is empty", ErrInvalidReceipt)
	}
	amt, ok := new(big.Int).SetString(r.AmountWei, 10)
	if !ok {
		return fmt.Errorf("%w: amount_wei is not a valid base-10 integer", ErrInvalidReceipt)
	}
	if amt.Sign() < 0 {
		return fmt.Errorf("%w: amount_wei is negative", ErrInvalidReceipt)
	}
	if r.RequestCanonical == "" {
		return fmt.Errorf("%w: request_canonical is empty", ErrInvalidReceipt)
	}
	if r.TxHash == "" {
		return fmt.Errorf("%w: tx_hash is empty", ErrInvalidReceipt)
	}
	if r.BlockNumber < 0 {
		return fmt.Errorf("%w: block_number is negative", ErrInvalidReceipt)
	}
	if r.BlockTimestamp.IsZero() {
		return fmt.Errorf("%w: block_timestamp is zero", ErrInvalidReceipt)
	}
	if r.ReceiptIssuedAt.IsZero() {
		return fmt.Errorf("%w: receipt_issued_at is zero", ErrInvalidReceipt)
	}
	if r.ReceiptExpiresAt.IsZero() {
		return fmt.Errorf("%w: receipt_expires_at is zero", ErrInvalidReceipt)
	}
	if !r.ReceiptExpiresAt.After(r.ReceiptIssuedAt) {
		return fmt.Errorf("%w: receipt_expires_at must be strictly after receipt_issued_at", ErrInvalidReceipt)
	}
	// Round-21 codex P3 (vendored mirror): same sub-second mutation
	// guard as the standalone module. Signing bytes truncate to Unix
	// seconds, so any non-zero nanosecond component is unsigned
	// territory and a holder could mutate it without invalidating the
	// signature.
	if r.BlockTimestamp.Nanosecond() != 0 {
		return fmt.Errorf("%w: block_timestamp must have zero sub-second precision", ErrInvalidReceipt)
	}
	if r.ReceiptIssuedAt.Nanosecond() != 0 {
		return fmt.Errorf("%w: receipt_issued_at must have zero sub-second precision", ErrInvalidReceipt)
	}
	if r.ReceiptExpiresAt.Nanosecond() != 0 {
		return fmt.Errorf("%w: receipt_expires_at must have zero sub-second precision", ErrInvalidReceipt)
	}
	return nil
}
