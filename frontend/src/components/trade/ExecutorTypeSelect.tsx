import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import type { ExecutorType } from "@/components/executor/types";
import { AnchoredMenu } from "@/components/ui/AnchoredMenu";

export interface ExecutorTypeOption {
  value: ExecutorType;
  label: string;
  icon: ReactNode;
}

/**
 * One-line stand-in for the Execute panel's type tabs.
 *
 * The panel is narrower than Order, Iceberg, Position, Grid, and DCA in a
 * row. This shows the current type and opens the same list.
 */
export function ExecutorTypeSelect({
  options,
  value,
  onChange,
}: {
  options: ExecutorTypeOption[];
  value: ExecutorType;
  onChange: (value: ExecutorType) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options.find((option) => option.value === value) ?? options[0];
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  useEffect(() => {
    if (open) setActive(selectedIndex);
  }, [open, selectedIndex]);

  if (!selected) return null;

  const choose = (next: ExecutorType) => {
    onChange(next);
    setOpen(false);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option.value);
    }
  };

  return (
    <div className="border-b border-[var(--color-border)]">
      <button
        ref={setAnchor}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(selectedIndex);
            setOpen(true);
          }
        }}
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-[11px] font-medium text-[var(--color-text)]"
      >
        <span className="sr-only">Executor type</span>
        <span className="shrink-0 text-[var(--color-primary)]" aria-hidden="true">
          {selected.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnchoredMenu
        id={listId}
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        matchAnchorWidth="exact"
        gap={1}
        role="listbox"
        ariaLabel="Executor type"
        ariaActiveDescendant={
          options[activeIndex] ? `${listId}-${options[activeIndex].value}` : undefined
        }
        onKeyDown={onListKeyDown}
      >
        {options.map((option, index) => {
          const isSelected = option.value === value;
          const isActive = index === activeIndex;
          return (
            <button
              key={option.value}
              id={`${listId}-${option.value}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option.value)}
              className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-[11px] font-medium ${
                isActive ? "bg-[var(--color-surface-hover)]" : ""
              } ${isSelected ? "text-[var(--color-primary)]" : "text-[var(--color-text)]"}`}
            >
              <span className="shrink-0" aria-hidden="true">
                {option.icon}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </AnchoredMenu>
    </div>
  );
}
