import type { FC } from "react";

import type { CantonReceipt } from "../lib/receipt";

export interface ReceiptViewProps {
  receipt?: CantonReceipt | null;
  resourceBody?: string | null;
}

// ReceiptView renders the participant-signed receipt + the unlocked
// resource body. The receipt itself is rendered with stable key order
// (the wire shape from /proof) so a screenshot diff has a hope of
// surviving across CI re-runs.
export const ReceiptView: FC<ReceiptViewProps> = ({ receipt, resourceBody }) => {
  if (!receipt && !resourceBody) {
    return null;
  }
  return (
    <section data-testid="receipt-view">
      {receipt ? (
        <details open>
          <summary>CantonReceipt</summary>
          <dl>
            <dt>orderId</dt>
            <dd data-testid="receipt-order-id">{receipt.orderId}</dd>
            <dt>transactionId</dt>
            <dd data-testid="receipt-tx-id">{receipt.transactionId}</dd>
            <dt>amount</dt>
            <dd>{receipt.amount} {receipt.currency}</dd>
            <dt>merchant</dt>
            <dd>{receipt.merchant}</dd>
            <dt>trustedIssuer</dt>
            <dd>{receipt.trustedIssuer}</dd>
            <dt>merchantRequestId</dt>
            <dd>{receipt.merchantRequestId}</dd>
            <dt>resource</dt>
            <dd>{receipt.resource}</dd>
            <dt>completedAt (ms)</dt>
            <dd>{receipt.completedAt}</dd>
          </dl>
          <pre data-testid="receipt-json">{JSON.stringify(receipt, null, 2)}</pre>
        </details>
      ) : null}
      {resourceBody ? (
        <>
          <h3>Unlocked resource</h3>
          <pre data-testid="resource-body">{resourceBody}</pre>
        </>
      ) : null}
    </section>
  );
};
