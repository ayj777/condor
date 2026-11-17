/**
 * Adding a MEXC perpetual key uses the same config-map form as every other
 * venue, and the exchange's own error is what the form shows.
 *
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerContext } from "@/hooks/useServer";
import { ApiKeysSettings } from "./ApiKeysSettings";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

const CONFIG_MAP = {
  config_map: {
    mexc_perpetual_api_key: {
      type: "str",
      required: true,
      prompt: "Enter your MEXC Perpetual API key",
    },
    mexc_perpetual_api_secret: {
      type: "str",
      required: true,
      prompt: "Enter your MEXC Perpetual API secret",
    },
  },
};

function respond(path: string, init?: RequestInit): Response {
  if (init?.method === "POST" && path.includes("/settings/credentials")) {
    return new Response(
      JSON.stringify({ detail: "Failed to add credentials: MEXC code 402: API Key expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (path.endsWith("/api/v1/servers")) {
    return new Response(
      JSON.stringify([{ name: "prod", host: "h", port: 8000, online: true, permission: "owner" }]),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  if (path.includes("/settings/credentials")) {
    return new Response(JSON.stringify({ credentials: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (path.includes("/config-map")) {
    return new Response(JSON.stringify(CONFIG_MAP), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (path.includes("/settings/connectors")) {
    return new Response(
      JSON.stringify({ connectors: [{ name: "mexc_perpetual", type: "perpetual" }] }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  if (path.includes("/gateway/")) {
    return new Response(JSON.stringify({ wallets: [], running: false }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => respond(path, init)),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found = all.find((b) => b.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("MEXC perpetual credentials", () => {
  it("offers the key and secret and shows the exchange error", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <ServerContext.Provider value={{ server: "prod", setServer: () => {} }}>
            <ApiKeysSettings />
          </ServerContext.Provider>
        </QueryClientProvider>,
      );
    });
    await flush();
    await act(async () => button("Add API Key").click());
    await act(async () => button("perpetual").click());
    await flush();
    expect(container.textContent).toContain("mexc_perpetual");

    await act(async () => button("mexc_perpetual").click());
    await flush();
    expect(container.textContent).toContain("mexc_perpetual_api_key");
    expect(container.textContent).toContain("mexc_perpetual_api_secret");

    await act(async () => button("Add Credential").click());
    await flush();

    expect(container.textContent).toContain("MEXC code 402: API Key expired");
  });
});
