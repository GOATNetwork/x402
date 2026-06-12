// Fastify sub-path export. Users opt in via:
//   import { fastifyPlugin } from "@goatnetwork/mpp-middleware/fastify";

export {
  fastifyPlugin,
  fastifyPreHandler,
  PAYMENT_RECEIPT_HEADER,
  type FastifyRejectCallback,
  type FastifyMppPluginOptions,
} from "./middleware-fastify.js";
