/**
 * The Execute panel's type control: one line, the same choices as the old tabs.
 *
 * @vitest-environment jsdom
 */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutorTypeSelect, type ExecutorTypeOption } from "./ExecutorTypeSelect";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const OPTIONS: ExecutorTypeOption[] = [
  { value: "order", label: "Order", icon: <span data-icon="order">O</span> },
  { value: "iceberg", label: "Iceberg", icon: <span data-icon="iceberg">I</span> },
  { value: "position", label: "Position", icon: <span data-icon="position">P</span> },
  { value: "grid", label: "Grid", icon: <span data-icon="grid">G</span> },
  { value: "dca", label: "DCA", icon: <span data-icon="dca">D</span> },
];

function Harness() {
  const [value, setValue] = useState<(typeof OPTIONS)[number]["value"]>("order");
  return <ExecutorTypeSelect options={OPTIONS} value={value} onChange={setValue} />;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<Harness />);
  });
}

const trigger = () => document.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']")!;
const list = () => document.querySelector<HTMLElement>("[role='listbox']");

function press(key: string, target: EventTarget) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ExecutorTypeSelect", () => {
  it("keeps the current type on one line and hides the other choices", () => {
    render();
    const button = trigger();
    expect(button.textContent).toContain("Order");
    expect(button.textContent).toContain("Executor type");
    expect(button.querySelector("[data-icon='order']")).not.toBeNull();
    expect(button.className).toContain("whitespace-nowrap");
    expect(list()).toBeNull();
    expect(document.body.textContent).not.toContain("Iceberg");
  });

  it("opens the same choices, each with its icon, and selects from the keyboard", () => {
    render();
    act(() => {
      trigger().click();
    });
    const menu = list()!;
    expect(menu.getAttribute("aria-label")).toBe("Executor type");
    const choices = [...menu.querySelectorAll<HTMLElement>("[role='option']")];
    expect(choices.map((node) => node.querySelector(".truncate")?.textContent)).toEqual([
      "Order",
      "Iceberg",
      "Position",
      "Grid",
      "DCA",
    ]);
    expect(menu.querySelector("[data-icon='iceberg']")).not.toBeNull();
    expect(choices[0].getAttribute("aria-selected")).toBe("true");

    press("ArrowDown", menu);
    press("Enter", menu);

    expect(list()).toBeNull();
    expect(trigger().textContent).toContain("Iceberg");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape without changing the type", () => {
    render();
    act(() => {
      trigger().click();
    });
    press("Escape", window);
    expect(list()).toBeNull();
    expect(trigger().textContent).toContain("Order");
  });
});
