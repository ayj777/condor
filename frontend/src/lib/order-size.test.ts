import { describe, expect, it } from "vitest";

import { baseAmountError, floorBaseAmount, formatTokenAmount, legalBaseAmount, percentBase, quantizePrice, roundDownNote, sizeUnitChoices, sizeUnitSymbol, snapBaseAmount } from "./order-size";

const AIOT = { minOrderSize: 10, increment: 10 };

describe("MEXC base size step", () => {
  it("floors the size that is sent and still offers a nearest snap", () => {
    expect(snapBaseAmount(15, 10)).toBe(20);
    expect(snapBaseAmount(14, 10)).toBe(10);
    expect(legalBaseAmount(15, AIOT)).toBe(10);
    expect(legalBaseAmount(6, AIOT)).toBe(0);
    expect(legalBaseAmount(12, AIOT)).toBe(10);
  });

  it("floors a percent size so it cannot overspend", () => {
    expect(floorBaseAmount(19.9, 10)).toBe(10);
    expect(floorBaseAmount(9, 10)).toBe(0);
  });

  it("keeps the create disabled below the minimum and names it", () => {
    expect(baseAmountError(0.001, AIOT, "AIOT")).toBe("Minimum order size is 10 AIOT");
    expect(baseAmountError(4, AIOT, "AIOT")).toBe("Minimum order size is 10 AIOT");
    expect(baseAmountError(0, AIOT, "AIOT")).toBe("Amount required");
  });

  it("rejects a size that floors below the minimum", () => {
    expect(baseAmountError(6, AIOT, "AIOT")).toBe("Minimum order size is 10 AIOT");
    expect(baseAmountError(15, AIOT, "AIOT")).toBeNull();
    expect(baseAmountError(20, AIOT, "AIOT")).toBeNull();
  });

  it("sizes a percent from the leverage that will be used", () => {
    expect(percentBase(1000, 1, 0.08, 2, 10)).toBe(25000);
    expect(percentBase(1000, 1, 0.08, 1, 10)).toBe(12500);
  });

  it("quantizes a price onto the tick", () => {
    expect(quantizePrice(0.081374, 0.00001)).toBeCloseTo(0.08137, 8);
    expect(quantizePrice(0.08, 0)).toBe(0.08);
  });

  it("floors a size that is not a whole contract and names the token", () => {
    const rule = { minOrderSize: 10, increment: 1, contractSize: 10 };
    expect(legalBaseAmount(25, rule)).toBe(20);
    expect(roundDownNote(25, 20, "AIOT")).toBe("Rounded down to 20 AIOT.");
    expect(roundDownNote(20, 20, "AIOT")).toBeNull();
    expect(formatTokenAmount(30000)).toBe("30,000");
    expect(formatTokenAmount(2430)).toBe("2,430");
    expect(sizeUnitSymbol("BASE", "AIOT-USDT")).toBe("AIOT");
    expect(sizeUnitSymbol("QUOTE", "AIOT-USDT")).toBe("USDT");
    expect(sizeUnitChoices("AIOT", "USDT")).toEqual([
      { value: "BASE", label: "AIOT" },
      { value: "QUOTE", label: "USDT" },
    ]);
  });

  it("leaves a venue with no step alone", () => {
    expect(legalBaseAmount(0.015, null)).toBe(0.015);
    expect(baseAmountError(0.015, null, "BTC")).toBeNull();
  });
});
