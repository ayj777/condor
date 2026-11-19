import { describe, expect, it } from "vitest";

import { baseAmountError, floorBaseAmount, formatTokenAmount, legalBaseAmount, percentBase, plainOrderPrice, plainOrderSentSize, plainOrderSummary, quantizePrice, roundDownNote, sizeUnitChoices, sizeUnitSymbol, sizedPercent, snapBaseAmount } from "./order-size";

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

describe("plain order quote size", () => {
  it("converts USDT at the limit price and floors to the size step", () => {
    expect(plainOrderPrice("LIMIT", 0.08, 0.1)).toBe(0.08);
    expect(plainOrderPrice("LIMIT", 0, 0.1)).toBeNull();
    expect(plainOrderPrice("MARKET", 0.08, 0.1)).toBe(0.1);
    const sent = plainOrderSentSize(100, "QUOTE", 0.081, AIOT, 0, { base: "AIOT", quote: "USDT" });
    expect(sent.error).toBeNull();
    expect(sent.base).toBe(1230);
    expect(sent.quote).toBeCloseTo(1230 * 0.081, 8);
    expect(plainOrderSummary(100, "QUOTE", sent, { base: "AIOT", quote: "USDT" })).toBe(
      "100 USDT, about 1,230 AIOT (approx 99.63 USDT)",
    );
  });

  it("converts a market order at the mid and blocks when no price is known", () => {
    const sent = plainOrderSentSize(80, "QUOTE", plainOrderPrice("MARKET", 0, 0.08), AIOT, 0, {
      base: "AIOT",
      quote: "USDT",
    });
    expect(sent.base).toBe(1000);
    expect(sent.error).toBeNull();
    const blocked = plainOrderSentSize(80, "QUOTE", plainOrderPrice("MARKET", 0, null), AIOT, 0, {
      base: "AIOT",
      quote: "USDT",
    });
    expect(blocked.base).toBe(0);
    expect(blocked.error).toBe("A price is required to convert quote size into the base token");
    expect(plainOrderSentSize(10, "QUOTE", null, AIOT).error).toMatch(/price is required/i);
  });

  it("clamps to the max base size and names the minimum in both units", () => {
    const clamped = plainOrderSentSize(100, "QUOTE", 0.08, AIOT, 500, { base: "AIOT", quote: "USDT" });
    expect(clamped.base).toBe(500);
    expect(clamped.error).toBeNull();
    const tiny = plainOrderSentSize(0.5, "QUOTE", 0.08, AIOT, 0, { base: "AIOT", quote: "USDT" });
    expect(tiny.error).toBe("Minimum order size is 10 AIOT (approx 0.8 USDT)");
  });

  it("writes a percent as quote in USDT mode and as base otherwise", () => {
    expect(sizedPercent({
      unit: "QUOTE",
      spendable: 1000,
      pct: 0.25,
      price: 0.08,
      leverage: 2,
      spendsBase: false,
      increment: 10,
    })).toBe(500);
    expect(sizedPercent({
      unit: "BASE",
      spendable: 1000,
      pct: 1,
      price: 0.08,
      leverage: 2,
      spendsBase: false,
      increment: 10,
    })).toBe(25000);
    expect(sizedPercent({
      unit: "QUOTE",
      spendable: 100,
      pct: 0.5,
      price: null,
      leverage: 1,
      spendsBase: true,
      increment: 10,
    })).toBeNull();
  });
});
