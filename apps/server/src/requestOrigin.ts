import { networkInterfaces } from "node:os";
import type { IncomingHttpHeaders } from "node:http";

export function isAllowedRequestOrigin(headers: IncomingHttpHeaders) {
  if (headers["sec-fetch-site"] === "cross-site") return false;
  if (!headers.origin) return true;

  try {
    const origin = new URL(headers.origin);

    if (
      origin.origin !== headers.origin ||
      origin.protocol !== "http:" ||
      !["5173", "5174", "4310"].includes(origin.port)
    )
      return false;

    const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        hosts.add(
          address.family === "IPv6" ? `[${address.address}]` : address.address,
        );
      }
    }

    return hosts.has(origin.hostname);
  } catch {
    return false;
  }
}
