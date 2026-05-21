import type { FC } from "react";

import type { FlowEvent, PhaseTag } from "../lib/flow";

export interface OrderStatusProps {
  events: FlowEvent[];
}

const ORDERED_PHASES: PhaseTag[] = [
  "READY",
  "DISCOVERY",
  "ORDER_CREATED",
  "SIGNED",
  "CHECKOUT_VERIFIED",
  "PAYMENT_CONFIRMED",
  "RESOURCE_FETCHED",
];

// OrderStatus renders the chronological list of phases the flow has
// reached. The most recent event is duplicated as a "current" line so the
// acceptance test (PLAN.md Task 13 — pass through CHECKOUT_VERIFIED →
// PAYMENT_CONFIRMED) can assert by text rather than by DOM index.
export const OrderStatus: FC<OrderStatusProps> = ({ events }) => {
  if (events.length === 0) {
    return <p className="status-line" data-testid="status-empty">No payment in progress.</p>;
  }
  const latest = events[events.length - 1];
  return (
    <section aria-live="polite">
      <p
        className={latest.phase === "ERROR" ? "status-line error" : "status-line"}
        data-testid="status-current"
        data-phase={latest.phase}
      >
        {latest.phase}: {latest.detail}
      </p>
      <ol data-testid="status-history">
        {events.map((ev, i) => (
          <li
            key={`${ev.phase}-${i}`}
            className="status-line"
            data-phase={ev.phase}
            data-testid={`status-event-${ev.phase}`}
          >
            <strong>{ev.phase}</strong>
            <span>{` — ${ev.detail}`}</span>
            {ev.error ? <span className="error">{` (${ev.error})`}</span> : null}
          </li>
        ))}
      </ol>
      <p className="status-line" data-testid="status-summary">
        Phases reached: {countReached(events)} / {ORDERED_PHASES.length - 1}
      </p>
    </section>
  );
};

function countReached(events: FlowEvent[]): number {
  const seen = new Set<PhaseTag>();
  for (const ev of events) {
    if (ev.phase !== "ERROR" && ev.phase !== "READY") {
      seen.add(ev.phase);
    }
  }
  return seen.size;
}
