import { useCallback, useMemo, useState } from "react";
import type { FC } from "react";

import { OrderStatus } from "./components/OrderStatus";
import { PayButton } from "./components/PayButton";
import { ReceiptView } from "./components/ReceiptView";
import { FacilitatorClient, MerchantClient } from "./lib/api";
import type { ClientEnv } from "./lib/env";
import { runFlow, type FlowEvent } from "./lib/flow";

export interface AppProps {
  env: ClientEnv;
  // fetchImpl + waitTimeoutMs overrides exist for the Vitest harness so the
  // generator can be driven against msw without hitting real network.
  fetchImpl?: typeof fetch;
}

export const App: FC<AppProps> = ({ env, fetchImpl }) => {
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const reason = useMemo<string | undefined>(() => {
    if (!env.payerToken) {
      return "VITE_PAYER_TOKEN unset — see docs/operator-handbook.md for the dev-only X-Payer-Token wiring.";
    }
    if (!env.payerParty) {
      return "VITE_PAYER_PARTY unset — bind the SPA to a payer Canton party id.";
    }
    return undefined;
  }, [env.payerToken, env.payerParty]);

  const disabled = reason !== undefined;

  const onPay = useCallback(async () => {
    if (disabled || busy) return;
    setEvents([]);
    setBusy(true);
    try {
      const facilitator = new FacilitatorClient({
        baseURL: env.facilitatorURL,
        payerToken: env.payerToken,
        fetchImpl,
      });
      const merchant = new MerchantClient({
        baseURL: env.merchantURL,
        resourcePath: env.resourcePath,
        fetchImpl,
      });
      const flow = runFlow({
        facilitator,
        merchant,
        merchantURL: env.merchantURL,
        resourcePath: env.resourcePath,
        payerParty: env.payerParty,
        sourceHoldingCID: env.sourceHoldingContractID,
        waitTimeoutMs: env.waitTimeoutMs,
      });
      for await (const ev of flow) {
        setEvents((prev) => [...prev, ev]);
      }
    } catch (err) {
      // runFlow is supposed to catch every failure and yield an ERROR
      // event; if something slips through, surface it here so the demo
      // never silently hangs.
      const message = err instanceof Error ? err.message : String(err);
      setEvents((prev) => [
        ...prev,
        { phase: "ERROR", detail: "uncaught error in flow", error: message },
      ]);
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, env, fetchImpl]);

  const lastReceipt = findLast(events, (ev) => Boolean(ev.receipt))?.receipt ?? null;
  const lastBody = findLast(events, (ev) => Boolean(ev.resourceBody))?.resourceBody ?? null;

  return (
    <main>
      <h1>goat-canton-payment — Pay with Canton</h1>
      <p>
        Demo SPA that mirrors the CLI's x402 → Canton round trip. Click the
        button below to fetch <code>{env.resourcePath}</code> from{" "}
        <code>{env.merchantURL}</code>; the merchant returns 402, the SPA
        orchestrates checkout through{" "}
        <code>{env.facilitatorURL}</code>, and replays the resulting{" "}
        <code>CantonReceipt</code> to unlock the resource.
      </p>
      <PayButton disabled={disabled} busy={busy} reason={reason} onClick={onPay} />
      <OrderStatus events={events} />
      <ReceiptView receipt={lastReceipt} resourceBody={lastBody} />
      <footer>
        <p>
          Payer party: <code data-testid="env-payer">{env.payerParty || "(unset)"}</code>
        </p>
        <p>
          Source-holding mode:{" "}
          <code data-testid="env-source-holding-mode">
            {env.sourceHoldingContractID ? "env (VITE_SOURCE_HOLDING_CID)" : "facilitator fallback"}
          </code>
        </p>
      </footer>
    </main>
  );
};

function findLast<T>(arr: T[], predicate: (value: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return arr[i];
  }
  return undefined;
}
