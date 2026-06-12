package receiptspec

import (
	"encoding/hex"
	"testing"
	"time"
)

// TestSigningBytes_GoldenFixture pins the on-wire canonical byte layout of
// this VENDORED receiptspec copy to the exact same hand-verified hex string
// used by the standalone goatx402-mpp-receipt-spec module
// (sign_test.go:TestSigningBytes_GoldenFixture) and the TS cross-validate
// fixture.
//
// Why this test exists here too: the sidecar verifies receipts with THIS
// vendored copy, while Core signs them with the standalone module. The
// middleware's own round-trip tests sign AND verify with this same copy, so a
// self-consistent reorder of fields in signingBytes would pass every other
// test in this module yet silently break interop with Core. Pinning the byte
// layout to the shared golden value is the only thing that catches such drift
// without a live cross-language run. If this fails, the vendored copy has
// diverged from the canonical wire format — fix the copy, do not regenerate
// the constant.
func TestSigningBytes_GoldenFixture(t *testing.T) {
	r := Receipt{
		ReceiptID:        "abc",
		ChallengeID:      "ch1",
		OrderID:          "ord1",
		MerchantID:       "m1",
		PayerAddr:        "0x1111111111111111111111111111111111111111",
		ChainID:          4217,
		TokenContract:    "0x2222222222222222222222222222222222222222",
		Recipient:        "0x3333333333333333333333333333333333333333",
		AmountWei:        "1000000",
		RequestCanonical: "GET /r",
		TxHash:           "0xabc",
		LogIndex:         5,
		BlockNumber:      100,
		BlockTimestamp:   time.Unix(1700000000, 0),
		ReceiptIssuedAt:  time.Unix(1700000000, 0),
		ReceiptExpiresAt: time.Unix(1700086400, 0),
	}
	got := hex.EncodeToString(SigningBytes(r))
	const want = "0000000361626300000003636831000000046f726431000000026d310000002a30783131313131313131313131313131313131313131313131313131313131313131313131313131313100000000000010790000002a3078323232323232323232323232323232323232323232323232323232323232323232323232323232320000002a307833333333333333333333333333333333333333333333333333333333333333333333333333333333000000073130303030303000000006474554202f7200000005307861626300000000000000050000000000000064000000006553f100000000006553f1000000000065554280"
	if got != want {
		t.Fatalf("vendored SigningBytes wire format drift vs canonical golden:\n got: %s\nwant: %s", got, want)
	}
}
