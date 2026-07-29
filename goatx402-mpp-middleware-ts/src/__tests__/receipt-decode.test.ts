// Unit tests for receipt decoding hardening — specifically the
// integer-field validation added to close the JS Number malleability
// gap. JavaScript treats every number as float64, so a wire payload
// like `log_index: 7.9` would otherwise truncate to 7 inside the
// signing-bytes int64 encoding and verify against an x402d signature
// that was produced over the integer 7. We reject such values at
// decode time so the JSON-layer contract matches what the signer saw.
//
// Companion tests for the timestamp string fields validate that they
// parse to a finite Date — the signing-bytes path also calls
// Date.parse, but failing fast at decode time produces a
// ReceiptDecodeError that the middleware reports as
// invalid_payment_receipt without going through any signature work.

import { describe, it, expect } from "vitest";
import {
  type Receipt,
  ReceiptDecodeError,
  decodeEnvelope,
  decodeHeader,
  signingBytes,
} from "../receipt.js";

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function validReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rid-abc",
    challenge_id: "ch1",
    order_id: "ord1",
    merchant_id: "m1",
    payer_addr: "0x1111111111111111111111111111111111111111",
    chain_id: 4217,
    token_contract: "0x2222222222222222222222222222222222222222",
    recipient: "0x3333333333333333333333333333333333333333",
    amount_wei: "1000000",
    request_canonical: "GET /widget",
    tx_hash: "0xabc",
    log_index: 5,
    block_number: 100,
    block_timestamp: "2023-11-14T22:13:20Z",
    receipt_issued_at: "2023-11-14T22:13:20Z",
    receipt_expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Builds a Payment-Receipt header value from an arbitrary (possibly invalid) receipt-shaped object. */
function buildHeaderFromRaw(raw: unknown): string {
  const body = JSON.stringify(raw);
  // Signature bytes are irrelevant — these tests assert that decode
  // rejects before any signature work runs.
  return `${b64u(new TextEncoder().encode(body))}.${b64u(new Uint8Array(64))}.ed25519`;
}

describe("receipt decode integer validation", () => {
  it("accepts integer chain_id / log_index / block_number (happy path)", () => {
    const r = validReceipt();
    const header = buildHeaderFromRaw(r);
    const decoded = decodeHeader(header);
    expect(decoded.receipt.log_index).toBe(5);
    expect(decoded.receipt.block_number).toBe(100);
    expect(decoded.receipt.chain_id).toBe(4217);
    // signingBytes still works on the decoded receipt.
    expect(signingBytes(decoded.receipt).byteLength).toBeGreaterThan(0);
  });

  it("rejects fractional log_index", () => {
    const raw = { ...validReceipt(), log_index: 7.9 };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(ReceiptDecodeError);
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/log_index/);
  });

  it("rejects fractional block_number", () => {
    const raw = { ...validReceipt(), block_number: 100.5 };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(ReceiptDecodeError);
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/block_number/);
  });

  it("rejects fractional chain_id", () => {
    const raw = { ...validReceipt(), chain_id: 1.1 };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(ReceiptDecodeError);
  });

  it("rejects negative log_index", () => {
    const raw = { ...validReceipt(), log_index: -1 };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/log_index/);
  });

  it("rejects log_index outside the safe-integer range", () => {
    // 2^60 cannot round-trip through Number without precision loss.
    const raw = { ...validReceipt(), log_index: Math.pow(2, 60) };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/safe-integer/);
  });

  it("rejects block_number outside the safe-integer range", () => {
    const raw = { ...validReceipt(), block_number: Math.pow(2, 60) };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/safe-integer/);
  });

  it("rejects Infinity and NaN", () => {
    // JSON cannot literally encode Infinity / NaN, but a hand-crafted
    // intermediate JS value could be passed to signingBytes directly.
    // signingBytes itself does not re-validate; the contract is that
    // values come from parseReceipt — confirm parseReceipt rejects.
    const rawInf = { ...validReceipt(), block_number: "Infinity" } as unknown as Receipt;
    expect(() => decodeHeader(buildHeaderFromRaw(rawInf))).toThrow(ReceiptDecodeError);
  });
});

describe("receipt decode timestamp validation", () => {
  it.each([
    "2023-02-29T00:00:00Z",
    "2024-02-30T00:00:00Z",
    "2023-04-31T00:00:00Z",
  ])("rejects impossible calendar date %s", (timestamp) => {
    const raw = { ...validReceipt(), block_timestamp: timestamp };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/block_timestamp/);
  });

  it("accepts a valid leap day and numeric offset", () => {
    const raw = {
      ...validReceipt(),
      block_timestamp: "2024-02-29T23:59:59+05:30",
    };
    expect(decodeHeader(buildHeaderFromRaw(raw)).receipt.block_timestamp).toBe(
      "2024-02-29T23:59:59+05:30",
    );
  });

  it("rejects unparseable block_timestamp", () => {
    const raw = { ...validReceipt(), block_timestamp: "not-a-date" };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/block_timestamp/);
  });

  it("rejects unparseable receipt_issued_at", () => {
    const raw = { ...validReceipt(), receipt_issued_at: "not-a-date" };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(/receipt_issued_at/);
  });

  it("rejects unparseable receipt_expires_at", () => {
    const raw = { ...validReceipt(), receipt_expires_at: "" };
    expect(() => decodeHeader(buildHeaderFromRaw(raw))).toThrow(ReceiptDecodeError);
  });

  it("decodeEnvelope enforces the same checks", () => {
    const env = {
      receipt: { ...validReceipt(), log_index: 7.9 },
      signature: b64u(new Uint8Array(64)),
      algorithm: "ed25519",
    };
    expect(() => decodeEnvelope(JSON.stringify(env))).toThrow(/log_index/);
  });
});
