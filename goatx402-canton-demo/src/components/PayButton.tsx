import type { FC, MouseEventHandler } from "react";

export interface PayButtonProps {
  disabled: boolean;
  busy: boolean;
  reason?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

// PayButton is the demo's single call-to-action. It is disabled with an
// inline reason when configuration is incomplete (e.g. VITE_PAYER_TOKEN
// unset — see PLAN.md Task 13 acceptance).
export const PayButton: FC<PayButtonProps> = ({ disabled, busy, reason, onClick }) => {
  const isDisabled = disabled || busy;
  return (
    <div>
      <button
        type="button"
        data-testid="pay-button"
        disabled={isDisabled}
        aria-disabled={isDisabled}
        onClick={onClick}
      >
        {busy ? "Paying…" : "Pay with Canton"}
      </button>
      {disabled && reason ? (
        <p className="error" data-testid="pay-button-reason">
          {reason}
        </p>
      ) : null}
    </div>
  );
};
