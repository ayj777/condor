import { describe, expect, it } from "vitest";

import { marketPairKey, positionOnMarket } from "./useMainControllerData";

describe("positionOnMarket", () => {
  const pairs = new Set([marketPairKey("AIOT-USDT")]);
  const live = {
    connector_name: "mexc_perpetual",
    trading_pair: "AIOT_USDT",
    controller_id: "master_account",
    source: "venue" as const,
  };

  it("keeps the exchange long even when the pair uses an underscore and a controller tag is set", () => {
    expect(positionOnMarket(live, "mexc_perpetual", pairs)).toBe(true);
    expect(positionOnMarket({ ...live, connector_name: "MEXC_PERPETUAL" }, "mexc_perpetual", pairs)).toBe(
      true,
    );
  });

  it("drops a different connector and a different pair", () => {
    expect(
      positionOnMarket({ ...live, connector_name: "binance_perpetual" }, "mexc_perpetual", pairs),
    ).toBe(false);
    expect(positionOnMarket(live, "mexc_perpetual", new Set([marketPairKey("BTC-USDT")]))).toBe(false);
  });

  it("drops a bot position tagged to another controller", () => {
    expect(
      positionOnMarket({ ...live, source: "bot", controller_id: "grid_1" }, "mexc_perpetual", pairs),
    ).toBe(false);
  });
});
