// Express sub-path export. Users opt in via:
//   import { expressMiddleware } from "@goatnetwork/mpp-middleware/express";

export {
  expressMiddleware,
  PAYMENT_RECEIPT_HEADER,
  type ExpressRejectCallback,
} from "./middleware-express.js";
