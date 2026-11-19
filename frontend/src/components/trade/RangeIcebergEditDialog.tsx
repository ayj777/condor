import { useReducer, useState } from "react";

import { ExitEditor } from "@/components/executor/RangeIcebergFields";
import { NumberField, PriceField } from "@/components/executor/fields";
import { orderReducer } from "@/components/executor/order-config";
import { ErrorToast } from "@/components/executor/ExecutorSuccessModal";
import { positionSideNotice } from "@/lib/api-error";
import type { ExecutorInfo } from "@/lib/api";
import { exitReference } from "@/lib/range-iceberg";
import { approximateQuoteLabel, pairTokens, referenceSizePrice } from "@/lib/order-size";
import {
  draftFromOrderState,
  normalizedEditDraft,
  orderStateForEdit,
  rangeIcebergEditFromExecutor,
  rangeIcebergEditPatch,
  rangeIcebergFilledCaption,
  rangeIcebergFilledInUnit,
  rangeIcebergSizeUnit,
  rangeIcebergTotalUnitLabel,
  validateRangeIcebergEdit,
} from "@/lib/range-iceberg-edit";

/**
 * Edit a live range iceberg. The amount, range, and exits start from the
 * executor. Only fields that changed are submitted.
 */
export function RangeIcebergEditDialog({
  executor,
  pending,
  error,
  markPrice = null,
  onClose,
  onSubmit,
}: {
  executor: ExecutorInfo;
  pending: boolean;
  error: string | null;
  /** Mid or last price, used when the executor has no average fill. */
  markPrice?: number | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const filled = rangeIcebergFilledInUnit(executor);
  const filledCaption = rangeIcebergFilledCaption(executor, executor.trading_pair);
  const totalUnit = rangeIcebergTotalUnitLabel(executor, executor.trading_pair);
  const { base, quote } = pairTokens(executor.trading_pair);
  const sizeUnit = rangeIcebergSizeUnit(executor);
  const sizePrice = referenceSizePrice(
    [executor.custom_info, executor.config, { current_price: executor.current_price }],
    markPrice,
  );
  const filledBase = sizeUnit === "BASE"
    ? filled
    : filledCaption.endsWith(base)
      ? Number(executor.custom_info?.filled_base)
      : null;
  const filledNote = filledBase != null && filledBase > 0
    ? approximateQuoteLabel(filledBase, sizePrice, quote)
    : "";
  const before = normalizedEditDraft(rangeIcebergEditFromExecutor(executor));
  const [state, dispatch] = useReducer(orderReducer, before, orderStateForEdit);
  const [localError, setLocalError] = useState<string | null>(null);
  const draft = draftFromOrderState(state);
  const reference = exitReference({
    mode: draft.mode,
    limitPrice: draft.limitPrice,
    priceLow: draft.priceLow,
    priceHigh: draft.priceHigh,
  });
  const which = draft.side === "SELL" ? "short" : "long";
  const kind = draft.mode === "UP_TO" ? "limit iceberg" : "range iceberg";

  function save() {
    const problem = validateRangeIcebergEdit(draft, filled);
    if (problem) {
      setLocalError(problem);
      return;
    }
    const patch = rangeIcebergEditPatch(before, draft);
    if (!patch) {
      setLocalError("Nothing changed.");
      return;
    }
    setLocalError(null);
    onSubmit(patch);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl">
        <p className="text-sm text-[var(--color-text)]">
          Edit {which} {kind}
        </p>
        {filledCaption && (
          <p className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">
            Filled {filledCaption}{filledNote ? ` (${filledNote})` : ""}
          </p>
        )}
        <div className="mt-3 space-y-2.5">
          <NumberField
            label={totalUnit ? `Total amount (${totalUnit})` : "Total amount"}
            value={state.ri_total_amount}
            field="ri_total_amount"
            dispatch={dispatch}
            step={0.001}
            min={0}
          />
          {sizeUnit === "BASE" && state.ri_total_amount > 0 && sizePrice != null && sizePrice > 0 && (
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {approximateQuoteLabel(state.ri_total_amount, sizePrice, quote)}
            </p>
          )}
          {draft.mode === "RANGE" && (
            <>
              <PriceField
                label="Price low"
                value={state.ri_price_low}
                field="ri_price_low"
                activePickField={state.activePickField}
                dispatch={dispatch}
                valid={state.ri_price_low > 0}
              />
              <PriceField
                label="Price high"
                value={state.ri_price_high}
                field="ri_price_high"
                activePickField={state.activePickField}
                dispatch={dispatch}
                valid={state.ri_price_high > 0 && state.ri_price_high >= state.ri_price_low}
              />
            </>
          )}
          <ExitEditor
            title="Take profit"
            kind="take_profit"
            prefix="ri_tp"
            stop={false}
            state={state}
            dispatch={dispatch}
            reference={reference}
          />
          <ExitEditor
            title="Stop loss"
            kind="stop_loss"
            prefix="ri_sl"
            stop
            state={state}
            dispatch={dispatch}
            reference={reference}
          />
        </div>
        {localError && (
          <p className="mt-2 text-[11px] text-[var(--color-red)]">{localError}</p>
        )}
        {error && <ErrorToast message={positionSideNotice(error)} />}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
