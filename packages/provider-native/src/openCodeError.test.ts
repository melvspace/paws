import { expect, it } from "vite-plus/test";
import { openCodeError } from "./openCodeError.ts";

it.each([
  [{ type: "provider.free-limit", status: 429 }, "free usage limit"],
  [{ type: "provider.quota", status: 402 }, "balance"],
  [{ type: "provider.quota", status: 429 }, "usage quota"],
  [{ type: "provider.rate-limit", status: 429 }, "rate limiting"],
  [{ status: 429 }, "rate limiting"],
  [{ status: 401 }, "rejected access"],
  [{ status: 403 }, "rejected access"],
  [{ type: "unknown" }, "could not finish"],
  [null, "could not finish"],
  ["private error", "could not finish"],
])(
  "explains a structured provider failure without exposing its payload: %j",
  (value, expected) => {
    expect(openCodeError(value).message).toContain(expected);
  },
);

it("does not show raw provider messages or response bodies", () => {
  for (const type of ["provider.free-limit", "unknown"]) {
    const error = openCodeError({
      type,
      message: "Authorization: Bearer private-token",
      response: { body: "private response payload" },
    });
    expect(error.message).not.toMatch(/private|Bearer|Authorization/);
  }
});
