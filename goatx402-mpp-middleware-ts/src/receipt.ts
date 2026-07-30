// Receipt value object + canonical signing-byte layout.
//
// This module is the TypeScript twin of goatx402-mpp-receipt-spec/sign.go
// + receipt.go + encode.go. The signing-bytes layout MUST match the Go
// implementation byte-for-byte; see the golden fixture test in
// __tests__/cross-validate.test.ts. Any change here without a matching
// Go change (and a protocol version bump) will break receipt verification
// across language ports.

/**
 * Signature algorithm identifier carried in the on-wire receipt header /
 * envelope. The verifier MUST reject any value not in this union.
 */
export type Algorithm = "ed25519" | "hmac-sha256";

/**
 * Returns true iff alg is one of the registered algorithm identifiers.
 * Centralises the check so unknown algorithms are rejected uniformly.
 */
export function isValidAlgorithm(alg: string): alg is Algorithm {
  return alg === "ed25519" || alg === "hmac-sha256";
}

/**
 * Receipt is the value object x402d signs and merchant middleware
 * verifies. Field order matches the Go SigningBytes() layout exactly —
 * do not reorder without bumping the protocol version.
 *
 * Timestamps are carried as ISO-8601 strings on the wire (matching Go's
 * time.Time JSON marshalling) and converted to Unix seconds for the
 * canonical signing-bytes payload.
 */
export interface Receipt {
  receipt_id: string;
  challenge_id: string;
  order_id: string;
  merchant_id: string;
  payer_addr: string;
  /** EVM chainID or Solana cluster code. Small integer, safe as JS Number. */
  chain_id: number;
  token_contract: string;
  recipient: string;
  /** Decimal string in smallest indivisible units. Avoids float pitfalls. */
  amount_wei: string;
  /** Canonicalised payment request the buyer attested to. */
  request_canonical: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  /** ISO-8601 UTC. */
  block_timestamp: string;
  /** ISO-8601 UTC. */
  receipt_issued_at: string;
  /** ISO-8601 UTC. */
  receipt_expires_at: string;
}

/**
 * The on-wire envelope used as a JSON body alternative to the
 * Payment-Receipt header. Matches Go's Envelope struct.
 */
export interface Envelope {
  receipt: Receipt;
  /** base64url (no padding) encoded raw signature bytes. */
  signature: string;
  algorithm: Algorithm;
}

// ---------- canonical signing-byte layout ----------

const textEncoder = new TextEncoder();

/**
 * Writes a length-prefixed string into buf at offset and returns the new
 * offset. Layout: uint32 big-endian length, followed by the raw UTF-8
 * bytes. Mirrors writeLP in sign.go.
 */
function writeLP(buf: Uint8Array, offset: number, s: string): number {
  const utf8 = textEncoder.encode(s);
  // uint32 big-endian length
  buf[offset] = (utf8.length >>> 24) & 0xff;
  buf[offset + 1] = (utf8.length >>> 16) & 0xff;
  buf[offset + 2] = (utf8.length >>> 8) & 0xff;
  buf[offset + 3] = utf8.length & 0xff;
  buf.set(utf8, offset + 4);
  return offset + 4 + utf8.length;
}

/**
 * Writes an int64 as 8 bytes big-endian (two's complement for negatives,
 * matching Go's binary.BigEndian.PutUint64(buf, uint64(n)) idiom).
 */
function writeInt64(buf: Uint8Array, offset: number, n: number | bigint): number {
  // BigInt lets us encode the full 64-bit range deterministically and
  // matches Go's int64. We accept number for convenience but convert
  // immediately.
  const v = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  // Mask to 64-bit two's complement representation.
  const u = v < 0n ? (1n << 64n) + v : v;
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(u >> BigInt((7 - i) * 8)) & 0xff;
  }
  return offset + 8;
}

/**
 * Writes a uint64 as 8 bytes big-endian. Equivalent to writeInt64 for
 * non-negative values; the separate name documents intent.
 */
function writeUint64(buf: Uint8Array, offset: number, n: number | bigint): number {
  return writeInt64(buf, offset, n);
}

/**
 * Parses an ISO-8601 timestamp into Unix seconds. Throws if the input
 * cannot be parsed.
 *
 * The Go implementation uses time.Time.Unix(), which floors to seconds.
 * We replicate that by doing Math.floor on the parsed millisecond value
 * — every receipt produced by x402d will have whole-second timestamps
 * anyway (Go's time.Unix(sec, 0) loses sub-second precision), but the
 * floor is defensive against any merchant that re-encodes a receipt
 * with sub-second precision before forwarding.
 */
function isoToUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`receipt: invalid ISO-8601 timestamp: ${iso}`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Computes the canonical signing-bytes for a receipt.
 *
 * Layout (must match sign.go signingBytes exactly):
 *   receipt_id            : LP-string
 *   challenge_id          : LP-string
 *   order_id              : LP-string
 *   merchant_id           : LP-string
 *   payer_addr            : LP-string
 *   chain_id              : int64 big-endian
 *   token_contract        : LP-string
 *   recipient             : LP-string
 *   amount_wei            : LP-string (decimal string)
 *   request_canonical     : LP-string
 *   tx_hash               : LP-string
 *   log_index             : uint64 big-endian
 *   block_number          : int64 big-endian
 *   block_timestamp       : int64 big-endian Unix seconds
 *   receipt_issued_at     : int64 big-endian Unix seconds
 *   receipt_expires_at    : int64 big-endian Unix seconds
 */
export function signingBytes(r: Receipt): Uint8Array {
  // Pre-compute UTF-8 byte lengths to allocate a single buffer.
  const strings: string[] = [
    r.receipt_id,
    r.challenge_id,
    r.order_id,
    r.merchant_id,
    r.payer_addr,
    r.token_contract,
    r.recipient,
    r.amount_wei,
    r.request_canonical,
    r.tx_hash,
  ];
  let totalStringBytes = 0;
  for (const s of strings) {
    totalStringBytes += textEncoder.encode(s).length;
  }
  // 10 LP-strings (4-byte length prefix each) + 6 fixed-width 8-byte
  // fields (chain_id, log_index, block_number, block_timestamp,
  // receipt_issued_at, receipt_expires_at).
  const totalLen = strings.length * 4 + totalStringBytes + 6 * 8;
  const buf = new Uint8Array(totalLen);

  let off = 0;
  off = writeLP(buf, off, r.receipt_id);
  off = writeLP(buf, off, r.challenge_id);
  off = writeLP(buf, off, r.order_id);
  off = writeLP(buf, off, r.merchant_id);
  off = writeLP(buf, off, r.payer_addr);
  off = writeInt64(buf, off, r.chain_id);
  off = writeLP(buf, off, r.token_contract);
  off = writeLP(buf, off, r.recipient);
  off = writeLP(buf, off, r.amount_wei);
  off = writeLP(buf, off, r.request_canonical);
  off = writeLP(buf, off, r.tx_hash);
  off = writeUint64(buf, off, r.log_index);
  off = writeInt64(buf, off, r.block_number);
  off = writeInt64(buf, off, isoToUnixSeconds(r.block_timestamp));
  off = writeInt64(buf, off, isoToUnixSeconds(r.receipt_issued_at));
  off = writeInt64(buf, off, isoToUnixSeconds(r.receipt_expires_at));

  // Sanity: we sized the buffer exactly; off must equal totalLen.
  if (off !== totalLen) {
    throw new Error(`receipt: signing-bytes size mismatch (off=${off} totalLen=${totalLen})`);
  }
  return buf;
}

// ---------- header / envelope decoding ----------

/**
 * Decodes a base64url (no padding) string. Throws on invalid input.
 *
 * Node's Buffer.from(..., 'base64url') accepts both padded and unpadded
 * input, which is what we want — but it is also permissive about
 * non-alphabet characters (silently dropping them in some versions). We
 * therefore do an additional regex check up front so callers see a
 * deterministic rejection.
 */
function base64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("base64url: contains invalid characters");
  }
  // Use globalThis.Buffer to keep this file Node-only (which is fine —
  // the package targets Node/Express/Fastify hosts).
  const buf = Buffer.from(s, "base64url");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Decoded Payment-Receipt header components.
 */
export interface DecodedHeader {
  receipt: Receipt;
  signature: Uint8Array;
  algorithm: Algorithm;
}

/** Custom error thrown by DecodeHeader / DecodeEnvelope for invalid input. */
export class ReceiptDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptDecodeError";
  }
}

/**
 * Parses a Payment-Receipt HTTP header value:
 *   base64url(JSON(receipt)).base64url(sig).<algorithm>
 *
 * Mirrors DecodeHeader in encode.go: requires exactly 3 dot-separated
 * parts, validates the algorithm identifier, base64url-decodes both
 * binary parts, and JSON-parses the receipt body strictly (unknown
 * fields cause rejection).
 *
 * Note: unlike the Go decoder we cannot easily forbid unknown fields at
 * JSON.parse time, so we do an explicit unknown-key check post-parse.
 * The set of permitted keys is the closed set documented on the Receipt
 * type. Any change to Receipt MUST update both sides.
 */
export function decodeHeader(header: string): DecodedHeader {
  if (typeof header !== "string" || header.length === 0) {
    throw new ReceiptDecodeError("header is empty");
  }
  const parts = header.split(".");
  if (parts.length !== 3) {
    throw new ReceiptDecodeError(
      `expected 3 dot-separated parts, got ${parts.length}`,
    );
  }
  const [bodyB64, sigB64, algStr] = parts;
  if (!isValidAlgorithm(algStr)) {
    throw new ReceiptDecodeError(`unknown algorithm: ${algStr}`);
  }
  let bodyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    bodyBytes = base64urlDecode(bodyB64);
  } catch (e) {
    throw new ReceiptDecodeError(
      `receipt part not valid base64url: ${(e as Error).message}`,
    );
  }
  try {
    sigBytes = base64urlDecode(sigB64);
  } catch (e) {
    throw new ReceiptDecodeError(
      `signature part not valid base64url: ${(e as Error).message}`,
    );
  }
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch (e) {
    throw new ReceiptDecodeError(
      `receipt body not valid UTF-8: ${(e as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    throw new ReceiptDecodeError(
      `receipt body not valid JSON: ${(e as Error).message}`,
    );
  }
  const receipt = parseReceipt(parsed);
  return { receipt, signature: sigBytes, algorithm: algStr };
}

/**
 * Parses a JSON envelope body (alternative to the dot-separated header).
 * Matches DecodeEnvelope in encode.go: strict unknown-field rejection
 * at both top level and inside the nested receipt.
 */
export function decodeEnvelope(data: string | Uint8Array | Buffer): DecodedHeader {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (e) {
      throw new ReceiptDecodeError(
        `envelope not valid UTF-8: ${(e as Error).message}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ReceiptDecodeError(
      `envelope not valid JSON: ${(e as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReceiptDecodeError("envelope is not a JSON object");
  }
  const envObj = parsed as Record<string, unknown>;
  const allowedEnvelopeKeys = new Set(["receipt", "signature", "algorithm"]);
  for (const k of Object.keys(envObj)) {
    if (!allowedEnvelopeKeys.has(k)) {
      throw new ReceiptDecodeError(`unknown envelope field: ${k}`);
    }
  }
  const algStr = envObj["algorithm"];
  if (typeof algStr !== "string" || !isValidAlgorithm(algStr)) {
    throw new ReceiptDecodeError(`unknown algorithm: ${String(algStr)}`);
  }
  const sigStr = envObj["signature"];
  if (typeof sigStr !== "string") {
    throw new ReceiptDecodeError("signature must be a string");
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64urlDecode(sigStr);
  } catch (e) {
    throw new ReceiptDecodeError(
      `signature not valid base64url: ${(e as Error).message}`,
    );
  }
  const receipt = parseReceipt(envObj["receipt"]);
  return { receipt, signature: sigBytes, algorithm: algStr };
}

// RFC3339_TIMESTAMP_RE matches the strict shape Go's encoding/json
// accepts for time.Time fields: `YYYY-MM-DDTHH:MM:SS(.fraction)?` plus
// either `Z` or a numeric offset `[+-]HH:MM`. Lower-case `t`/`z`
// separators are NOT accepted by Go's parser, so we don't accept them
// here either. Round-36 codex P2.
const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidRFC3339CalendarValue(value: string): boolean {
  const match = RFC3339_TIMESTAMP_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHour > 23 || offsetMinute > 59) {
    return false;
  }

  const daysPerMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysPerMonth[month - 1];
}

// Closed set of permitted receipt keys. Kept in lock-step with the
// Receipt interface above; if you add a field there, add it here AND
// update signingBytes' layout AND bump the protocol version.
const RECEIPT_KEYS = new Set([
  "receipt_id",
  "challenge_id",
  "order_id",
  "merchant_id",
  "payer_addr",
  "chain_id",
  "token_contract",
  "recipient",
  "amount_wei",
  "request_canonical",
  "tx_hash",
  "log_index",
  "block_number",
  "block_timestamp",
  "receipt_issued_at",
  "receipt_expires_at",
]);

/**
 * Strictly parses an arbitrary JSON value into a Receipt. Rejects
 * unknown fields, missing fields, and wrong-typed fields.
 */
function parseReceipt(v: unknown): Receipt {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ReceiptDecodeError("receipt is not a JSON object");
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!RECEIPT_KEYS.has(k)) {
      throw new ReceiptDecodeError(`unknown receipt field: ${k}`);
    }
  }
  // reqString enforces both type and non-emptiness. Round-17 codex P2:
  // matching Go's Receipt.Validate(), every required string field must
  // be non-empty — an empty `merchant_id` or `tx_hash`, for example,
  // is a structurally-invalid receipt even if it was correctly signed.
  // Without this check the TS port would accept signed-but-empty
  // fields the Go middleware rejects, creating cross-SDK drift.
  function reqString(key: string): string {
    const x = o[key];
    if (typeof x !== "string") {
      throw new ReceiptDecodeError(`field ${key} must be a string`);
    }
    if (x === "") {
      throw new ReceiptDecodeError(`field ${key} must not be empty`);
    }
    return x;
  }
  // reqInteger validates that the field is a number that is finite,
  // an integer (no fractional part), and within the safe-integer range
  // (±2^53 - 1). This closes the JS-Number malleability gap: a JSON
  // value like `7.9` would otherwise truncate inside the signing-bytes
  // int64 encoding (via BigInt(Math.trunc(n))) and verify against a
  // signature that was produced by x402d over the integer 7 — letting
  // an attacker mutate non-integer payload fields without breaking the
  // signature. Safe-integer bounds also reject 2^60-style values that
  // would silently lose precision when round-tripped through Number.
  // Integer chain_id, log_index, and block_number all fit comfortably
  // within the safe-integer range for every realistic chain.
  function reqInteger(key: string, minValue: number | null = null): number {
    const x = o[key];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new ReceiptDecodeError(`field ${key} must be a finite number`);
    }
    if (!Number.isInteger(x)) {
      throw new ReceiptDecodeError(`field ${key} must be an integer`);
    }
    if (!Number.isSafeInteger(x)) {
      throw new ReceiptDecodeError(`field ${key} is outside the safe-integer range`);
    }
    if (minValue !== null && x < minValue) {
      throw new ReceiptDecodeError(`field ${key} must be >= ${minValue}`);
    }
    return x;
  }
  // reqTimestamp validates that the field is a non-empty ISO-8601
  // string that parses to a finite Date. The signing-bytes path also
  // calls Date.parse via isoToUnixSeconds, but validating at decode
  // time produces a deterministic ReceiptDecodeError before any
  // signature work, matching the behaviour for the integer fields.
  function reqTimestamp(key: string): string {
    const s = reqString(key);
    // Round-36 codex P2: Go's encoding/json only unmarshals `time.Time`
    // from strict RFC3339 / RFC3339Nano. JS `Date.parse` accepts much
    // wider shapes (`2026-01-01`, `2026/01/01 00:00 UTC`, ...) that
    // can resolve to the same Unix-second and thus the same signing
    // bytes — letting a TS-side holder mutate the textual form of a
    // signed timestamp without invalidating the signature, while the
    // same JSON would be rejected by a Go verifier. Enforce the
    // canonical shape before parsing so cross-language verification
    // is bytewise-consistent.
    if (!isValidRFC3339CalendarValue(s)) {
      throw new ReceiptDecodeError(`field ${key} must be RFC3339 (e.g. 2026-01-01T00:00:00Z)`);
    }
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) {
      throw new ReceiptDecodeError(`field ${key} is not a valid ISO-8601 timestamp`);
    }
    // Round-21 codex P3 / round-46 codex P2: the canonical signing-
    // bytes truncate every timestamp to Unix seconds, so any non-zero
    // sub-second component is NOT covered by the signature. The
    // millisecond-modulo check below catches `...00Z` →
    // `...00.999Z`-style mutations, but nanosecond-resolution
    // mutations like `...00.000000001Z` get rounded by Date.parse to
    // an exact millisecond (ms % 1000 == 0), so they slip past
    // that check — Go's Receipt.Validate rejects them on
    // Nanosecond() != 0. Examine the textual fractional component
    // directly so the two verifiers agree byte-for-byte.
    const fractionMatch = /\.(\d+)/.exec(s);
    if (fractionMatch && /[1-9]/.test(fractionMatch[1])) {
      throw new ReceiptDecodeError(`field ${key} must not carry sub-second precision`);
    }
    if (ms % 1000 !== 0) {
      throw new ReceiptDecodeError(`field ${key} must not carry sub-second precision`);
    }
    return s;
  }
  // reqAmountWei validates that amount_wei is a non-empty base-10
  // decimal string that parses as a non-negative BigInt. Round-17
  // codex P2: Go's Receipt.Validate uses big.Int.SetString(s, 10) +
  // Sign() >= 0, so the TS port must reject "abc", "-1", "1e5",
  // "0x10", and other shapes the Go side would. Using a regex first
  // because BigInt("") throws SyntaxError but BigInt("0x10") and
  // BigInt("1e5") both succeed silently — neither would round-trip
  // through Go's strict base-10 parser.
  function reqAmountWei(key: string): string {
    const s = reqString(key);
    if (!/^(0|[1-9][0-9]*)$/.test(s)) {
      throw new ReceiptDecodeError(`field ${key} is not a base-10 non-negative integer`);
    }
    return s;
  }
  const r: Receipt = {
    receipt_id: reqString("receipt_id"),
    challenge_id: reqString("challenge_id"),
    order_id: reqString("order_id"),
    merchant_id: reqString("merchant_id"),
    payer_addr: reqString("payer_addr"),
    chain_id: reqInteger("chain_id", 0),
    token_contract: reqString("token_contract"),
    recipient: reqString("recipient"),
    amount_wei: reqAmountWei("amount_wei"),
    request_canonical: reqString("request_canonical"),
    tx_hash: reqString("tx_hash"),
    log_index: reqInteger("log_index", 0),
    block_number: reqInteger("block_number", 0),
    block_timestamp: reqTimestamp("block_timestamp"),
    receipt_issued_at: reqTimestamp("receipt_issued_at"),
    receipt_expires_at: reqTimestamp("receipt_expires_at"),
  };
  // Round-17 codex P2: enforce the cross-field invariant Go's
  // Receipt.Validate also checks — a receipt whose expiry does not
  // strictly succeed its issued-at is structurally invalid. The
  // step-4 expiry gate later in verify.ts would surface it only if
  // `now >= expires`, but a receipt issued at noon with
  // `expires_at <= issued_at` is malformed regardless of when it is
  // verified and we reject it here for byte-for-byte parity.
  if (Date.parse(r.receipt_expires_at) <= Date.parse(r.receipt_issued_at)) {
    throw new ReceiptDecodeError(
      "receipt_expires_at must be strictly after receipt_issued_at",
    );
  }
  return r;
}
