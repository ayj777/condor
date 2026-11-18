import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ExecutorInfo } from "@/lib/api";
import { executorHoverModel, placePopup, type PopupAnchor } from "@/lib/executor-hover";

function readAnchor(el: HTMLElement): PopupAnchor {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width };
}

function inDetail(node: EventTarget | null, id: string): boolean {
  if (!(node instanceof Element)) return false;
  const card = node.closest("[data-executor-detail]");
  return card?.getAttribute("data-executor-detail") === id;
}

/** Hover and keyboard focus for one executor row. The card itself is portalled. */
function useExecutorHover(executor: ExecutorInfo) {
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  const open = anchor !== null;

  useEffect(() => {
    if (!open) return;
    const sync = () => {
      const row = rowRef.current;
      if (row) setAnchor(readAnchor(row));
    };
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [open]);

  const props = {
    tabIndex: 0 as const,
    "aria-describedby": open ? `executor-detail-${executor.id}` : undefined,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      rowRef.current = event.currentTarget;
      setAnchor(readAnchor(event.currentTarget));
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      if (event.currentTarget === document.activeElement) return;
      if (inDetail(event.relatedTarget, executor.id)) return;
      setAnchor(null);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      rowRef.current = event.currentTarget;
      setAnchor(readAnchor(event.currentTarget));
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setAnchor(null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      setAnchor(null);
      event.currentTarget.blur();
    },
  };
  const popup = anchor ? (
    <ExecutorDetailPopup
      executor={executor}
      anchor={anchor}
      onMouseLeave={(event) => {
        if (inDetail(event.relatedTarget, executor.id)) return;
        const row = rowRef.current;
        if (row && event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
        if (row && row === document.activeElement) return;
        setAnchor(null);
      }}
    />
  ) : null;
  return { props, popup };
}

export function ExecutorHoverRow({
  executor,
  className,
  style,
  onClick,
  children,
}: {
  executor: ExecutorInfo;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children: ReactNode;
}) {
  const { props, popup } = useExecutorHover(executor);
  return (
    <tr {...props} className={className} style={style} onClick={onClick}>
      {children}
      {popup}
    </tr>
  );
}

export function ExecutorDetailPopup({
  executor,
  anchor,
  now,
  onMouseLeave,
}: {
  executor: ExecutorInfo;
  anchor: PopupAnchor;
  now?: number;
  onMouseLeave?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const model = executorHoverModel(executor, now);
  const [box, setBox] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      setBox(
        placePopup(
          anchor,
          { width: card.offsetWidth, height: card.scrollHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, executor, now]);

  return createPortal(
    <div
      ref={cardRef}
      id={`executor-detail-${executor.id}`}
      data-executor-detail={executor.id}
      role="tooltip"
      onMouseLeave={onMouseLeave}
      className="fixed z-[9999] w-[320px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/95 p-2.5 text-[11px] shadow-xl backdrop-blur-sm"
      style={{
        top: box?.top ?? -9999,
        left: box?.left ?? 8,
        maxHeight: box?.maxHeight ?? 360,
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-medium text-[var(--color-text)]">{model.type}</span>
        {model.side && (
          <span className="rounded bg-[var(--color-surface)] px-1 py-0.5 text-[9px] font-bold uppercase">
            {model.side}
          </span>
        )}
        {model.positionSide && (
          <span className="text-[10px] text-[var(--color-text-muted)]">{model.positionSide}</span>
        )}
        {model.status && (
          <span className="ml-auto text-[10px] capitalize text-[var(--color-text-muted)]">{model.status}</span>
        )}
      </div>
      {model.warnings.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {model.warnings.map((warning) => (
            <p
              key={`${warning.title}:${warning.detail}`}
              role="status"
              className="rounded border border-[var(--color-yellow)]/50 bg-[var(--color-yellow)]/10 px-1.5 py-1 text-[10px] text-[var(--color-text)]"
            >
              <span className="font-medium">{warning.title}</span>
              {warning.detail ? (
                <span className="mt-0.5 block break-words font-mono text-[var(--color-text-muted)]">{warning.detail}</span>
              ) : null}
            </p>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {model.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-[var(--color-text-muted)]">{row.label}</dt>
            <dd className="truncate text-right font-mono text-[var(--color-text)]">{row.value}</dd>
          </div>
        ))}
      </dl>
      {model.orders.length > 0 && (
        <ul className="mt-1.5 space-y-1 border-t border-[var(--color-border)] pt-1.5">
          {model.orders.map((order, index) => (
            <li key={`${order.price}-${order.amount}-${index}`} className="font-mono text-[10px]">
              <span className="text-[var(--color-text)]">
                {order.price || "mkt"} · {order.amount || "?"}
                {order.filled ? ` · filled ${order.filled}` : ""}
              </span>
              <span className="block truncate text-[var(--color-text-muted)]">{order.status}</span>
            </li>
          ))}
        </ul>
      )}
      {(model.closeType || model.statusMessage) && (
        <p className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 text-[10px] text-[var(--color-text-muted)]">
          {model.closeType && <span className="font-medium text-[var(--color-text)]">{model.closeType}. </span>}
          {model.statusMessage}
        </p>
      )}
    </div>,
    document.body,
  );
}
