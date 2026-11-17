import { describe, expect, it } from "vitest";

import { baseAmountError, floorBaseAmount, legalBaseAmount, snapBaseAmount } from "./order-size";

const AIOT = { minOrderSize: 10, increment: 10 };

describe("MEXC base size step", () => {
  it("snaps to the 10-unit increment", () => {
    expect(snapBaseAmount(15, 10)).toBe(20);
    expect(snapBaseAmount(14, 10)).toBe(10);
    expect(snapBaseAmount(10, 10)).toBe(10);
    expect(legalBaseAmount(12, AIOT)).toBe(10);
  });

  it("floors a percent size so it cannot overspend", () => {
    expect(floorBaseAmount(19.9, 10)).toBe(10);
    expect(floorBaseAmount(9, 10)).toBe(0);
  });

  it("keeps the create disabled below the minimum and names it", () => {
    expect(baseAmountError(0.001, AIOT, "AIOT")).toBe("Minimum order size is 10 AIOT");
    expect(baseAmountError(4, AIOT, "AIOT")).toBe("Minimum order size is 10 AIOT");
    expect(baseAmountError(0, AIOT, "AIOT")).toBe("Amount required (base currency)");
  });

  it("allows a size that snaps onto the minimum", () => {
    expect(baseAmountError(6, AIOT, "AIOT")).toBeNull();
    expect(baseAmountError(20, AIOT, "AIOT")).toBeNull();
  });

  it("leaves a venue with no step alone", () => {
    expect(legalBaseAmount(0.015, null)).toBe(0.015);
    expect(baseAmountError(0.015, null, "BTC")).toBeNull();
  });
});
