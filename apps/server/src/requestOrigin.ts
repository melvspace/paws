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

// Loading a sign-in page grants no access. Browser wrappers and external links
// do not reliably preserve navigation metadata; validate the destination host,
// and enforce the ordinary origin policy on submissions instead.
export function isAllowedSignInRequest(
  headers: IncomingHttpHeaders,
  method: string | undefined,
) {
  if (!isAllowedRequestOrigin({ origin: `http://${headers.host}` }))
    return false;

  return method === "GET" || isAllowedRequestOrigin(headers);
}
