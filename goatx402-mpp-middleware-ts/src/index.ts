// Public API for the framework-agnostic core. Framework adapters live
// in separate entry points (./express, ./fastify) so users don't bring
// both dependencies unconditionally.

export {
  type Algorithm,
  type Receipt,
  type Envelope,
  type DecodedHeader,
  ReceiptDecodeError,
  isValidAlgorithm,
  signingBytes,
  decodeHeader,
  decodeEnvelope,
} from "./receipt.js";

export {
  type VerifyConfig,
  type VerifyResult,
  type RejectReason,
  type ReceiptIDStore,
  InMemoryReceiptIDStore,
  validateConfig,
  verifyReceipt,
} from "./verify.js";
