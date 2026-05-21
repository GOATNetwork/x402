// CantonReceipt mirrors the Go type in pkg/receipt/receipt.go (PLAN.md §5.1
// GET /proof). The wire shape is the public contract; field order and casing
// match the JSON Schema in docs/canton-receipt.schema.json.
export interface CantonReceipt {
  version: string;
  domain: string;
  orderId: string;
  ledgerId: string;
  transactionId: string;
  contractId: string;
  paymentRequestContractId: string;
  participantPartyId: string;
  merchant: string;
  payer: string;
  amount: string;
  currency: string;
  trustedIssuer: string;
  resource: string;
  merchantRequestId: string;
  expiresAtHttp: number;
  expiresAtDaml: number;
  signatureScheme: string;
  signature: string;
  receiptPayloadHash: string;
  completedAt: number;
}

// encodeReceiptForHeader produces the base64 string the merchant accepts in
// the X-PAYMENT header (PLAN.md §5.3). The merchant verifier base64-decodes
// the header value and then json.Unmarshal-s into receipt.CantonReceipt; the
// signature was made server-side over canonical bytes so the encoder here
// does not need to re-canonicalise.
export function encodeReceiptForHeader(r: CantonReceipt): string {
  const json = JSON.stringify(r);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64");
  }
  // Browser path: encodeURIComponent + unescape narrows UTF-8 codepoints
  // into the Latin-1 byte range btoa accepts.
  const utf8 = utf8BinaryString(json);
  return btoa(utf8);
}

function utf8BinaryString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}
