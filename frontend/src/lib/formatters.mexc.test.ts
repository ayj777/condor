import { describe, expect, it } from "vitest";

import { formatConnectorName } from "./formatters";

describe("formatConnectorName", () => {
  it("prints MEXC in capitals", () => {
    expect(formatConnectorName("mexc_perpetual")).toBe("MEXC Perp");
    expect(formatConnectorName("binance_perpetual")).toBe("Binance Perp");
  });
});
