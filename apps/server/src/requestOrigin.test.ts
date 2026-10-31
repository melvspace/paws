import { expect, it, vi } from "vite-plus/test";
import { isAllowedRequestOrigin } from "./requestOrigin.ts";

vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    lan: [{ address: "192.168.88.5", family: "IPv4" }],
    tailscale: [{ address: "100.117.217.1", family: "IPv4" }],
  }),
}));

it("accepts local and desktop LAN origins, rejects foreign browser origins", () => {
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://192.168.88.5:5173",
    "http://192.168.88.5:5174",
    "http://100.117.217.1:5173",
    "http://100.117.217.1:5174",
  ]) {
    expect(isAllowedRequestOrigin({ origin })).toBe(true);
  }

  for (const origin of [
    "http://192.168.88.6:5173",
    "http://100.91.247.17:5174",
    "https://foreign.example",
    "http://192.168.88.5:9999",
    "null",
    "http://192.168.88.5:5173/path",
    "http://192.168.88.5:5173@foreign.example",
  ]) {
    expect(isAllowedRequestOrigin({ origin })).toBe(false);
  }

  expect(
    isAllowedRequestOrigin({
      origin: "http://192.168.88.5:5173",
      "sec-fetch-site": "cross-site",
    }),
  ).toBe(false);
  expect(isAllowedRequestOrigin({})).toBe(true);
});
