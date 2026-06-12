// Cross-validation against the Go receipt-spec golden fixture.
//
// The Go side pins TestSigningBytes_GoldenFixture in
// goatx402-mpp-receipt-spec/sign_test.go — the hex string below is the
// EXACT same `want` literal. Any drift here means the TS port's
// canonical signing-bytes layout disagrees with the Go reference, and
// signatures produced by the Go signer will fail to verify in TS (or
// vice versa).
//
// To regenerate (if and only if the protocol version is intentionally
// bumped): copy the new `want` string from the Go test, paste here.

import { describe, it, expect } from "vitest";
import { type Receipt, signingBytes } from "../receipt.js";

/** The fixture below mirrors the literal in sign_test.go exactly. */
const goldenReceipt: Receipt = {
  receipt_id: "abc",
  challenge_id: "ch1",
  order_id: "ord1",
  merchant_id: "m1",
  payer_addr: "0x1111111111111111111111111111111111111111",
  chain_id: 4217,
  token_contract: "0x2222222222222222222222222222222222222222",
  recipient: "0x3333333333333333333333333333333333333333",
  amount_wei: "1000000",
  request_canonical: "GET /r",
  tx_hash: "0xabc",
  log_index: 5,
  block_number: 100,
  // time.Unix(1700000000, 0) → 2023-11-14T22:13:20Z
  block_timestamp: "2023-11-14T22:13:20Z",
  // Same value as block_timestamp per MPP convention.
  receipt_issued_at: "2023-11-14T22:13:20Z",
  // time.Unix(1700086400, 0) → 2023-11-15T22:13:20Z
  receipt_expires_at: "2023-11-15T22:13:20Z",
};

const GOLDEN_HEX =
  "0000000361626300000003636831000000046f726431000000026d310000002a30783131313131313131313131313131313131313131313131313131313131313131313131313131313100000000000010790000002a3078323232323232323232323232323232323232323232323232323232323232323232323232323232320000002a307833333333333333333333333333333333333333333333333333333333333333333333333333333333000000073130303030303000000006474554202f7200000005307861626300000000000000050000000000000064000000006553f100000000006553f1000000000065554280";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

describe("signingBytes (cross-validation against Go golden fixture)", () => {
  it("produces byte-identical output to the Go reference", () => {
    const got = toHex(signingBytes(goldenReceipt));
    expect(got).toBe(GOLDEN_HEX);
  });

  it("is deterministic across calls", () => {
    const a = signingBytes(goldenReceipt);
    const b = signingBytes(goldenReceipt);
    expect(toHex(a)).toBe(toHex(b));
  });

  it("changes for every binding field mutation", () => {
    // Mirror the Go receiptMutations test: each field, when changed,
    // MUST produce different signing bytes.
    const base = signingBytes(goldenReceipt);
    const mutations: Array<[keyof Receipt, Receipt[keyof Receipt]]> = [
      ["receipt_id", "tampered"],
      ["challenge_id", "tampered"],
      ["order_id", "tampered"],
      ["merchant_id", "tampered"],
      ["payer_addr", "tampered"],
      ["chain_id", goldenReceipt.chain_id + 1],
      ["token_contract", "tampered"],
      ["recipient", "tampered"],
      ["amount_wei", "9999"],
      ["request_canonical", "tampered"],
      ["tx_hash", "tampered"],
      ["log_index", goldenReceipt.log_index + 1],
      ["block_number", goldenReceipt.block_number + 1],
      ["block_timestamp", "2023-11-14T22:13:21Z"],
      ["receipt_issued_at", "2023-11-14T22:13:21Z"],
      ["receipt_expires_at", "2023-11-15T22:13:21Z"],
    ];
    for (const [key, val] of mutations) {
      const tampered: Receipt = { ...goldenReceipt, [key]: val } as Receipt;
      const got = signingBytes(tampered);
      expect(
        toHex(got),
        `mutation ${key} did not change signing bytes`,
      ).not.toBe(toHex(base));
    }
  });
});
