/**
 * GOAT Flow Server SDK
 *
 * TypeScript SDK for server-side GOAT Flow payment integration.
 * This SDK handles API authentication securely - never expose credentials to the frontend!
 *
 * @example
 * ```typescript
 * import { GoatFlowClient } from 'goatflow-sdk-server'
 *
 * const client = new GoatFlowClient({
 *   baseUrl: 'https://flow-api.goat.network',
 *   apiKey: process.env.GOATX402_API_KEY!,
 *   apiSecret: process.env.GOATX402_API_SECRET!,
 * })
 *
 * // Create an order
 * const fromAddress = '0xBuyerAddress'
 * const order = await client.createOrder({
 *   dappOrderId: 'my-order-123',
 *   chainId: 2345, // GOAT Mainnet example; use a runtime-supported chain
 *   tokenSymbol: 'USDC',
 *   fromAddress,
 *   amountWei: '1000000',
 * })
 *
 * // Map to goatflow-sdk's browser Order before returning it for payment.
 * res.json({
 *   orderId: order.orderId,
 *   flow: order.flow,
 *   tokenSymbol: order.tokenSymbol,
 *   tokenContract: order.tokenContract,
 *   fromAddress,
 *   payToAddress: order.payToAddress,
 *   chainId: order.fromChainId,
 *   amountWei: order.amountWei,
 *   expiresAt: order.expiresAt,
 *   calldataSignRequest: order.calldataSignRequest,
 * })
 * ```
 */

export { GoatFlowClient } from './client.js'
export { calculateSignature, signRequest } from './signature.js'

// x402 helper functions
export { toCAIP2, fromCAIP2, parseX402Header, GoatFlowError } from './types.js'

export type {
  GoatFlowConfig,
  CreateOrderParams,
  CreateCheckoutSessionParams,
  CheckoutSession,
  PaymentRail,
  CreateDelegateCheckoutSessionParams,
  DelegateCheckoutSession,
  Order,
  OrderProof,
  OrderProofResponse,
  OrderStatus,
  PaymentFlow,
  MerchantInfo,
  MerchantToken,
  CalldataSignRequest,
  EIP712Domain,
  EIP712Type,
  // x402 types
  X402PaymentRequired,
  X402PaymentOption,
  X402Resource,
  X402GoatExtension,
} from './types.js'
