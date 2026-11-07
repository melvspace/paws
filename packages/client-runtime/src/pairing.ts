import { Schema } from "effect";
import {
  EnvironmentIdentity,
  PairedEnvironment,
  PairingClaim,
  PairingOffer,
  PairingTicket,
  type DiscoveredEnvironment,
} from "@paws/contracts";
import type { RemoteConnection, RemoteRequest } from "./remote.ts";

export function environmentOrigin(input: string) {
  const url = new URL(input.trim());
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const octets = host.split(".").map(Number);
  const ipv4 =
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const privateHost =
    (ipv4 &&
      (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
        (octets[0] === 169 && octets[1] === 254))) ||
    host === "::1" ||
    /^f[cd][a-f0-9]{2}:/i.test(host);

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTPS address or a private LAN / Tailscale address without a path.",
    );
  }

  return url.origin;
}

export function pairingQr(offer: PairingOffer) {
  return `paws://pair#${encodeURIComponent(JSON.stringify(offer))}`;
}

export function parsePairingQr(value: string, now = Date.now()): PairingOffer {
  if (value.length > 8192)
    throw new Error("This is not a Paws pairing QR code.");

  try {
    const url = new URL(value);

    if (
      url.protocol !== "paws:" ||
      url.hostname !== "pair" ||
      url.search ||
      url.pathname
    )
      throw new Error();

    const offer = Schema.decodeUnknownSync(PairingOffer)(
      JSON.parse(decodeURIComponent(url.hash.slice(1))),
    );

    if (!offer.addresses.length) throw new Error();

    offer.addresses.forEach(environmentOrigin);

    if (
      !Number.isFinite(Date.parse(offer.expiresAt)) ||
      Date.parse(offer.expiresAt) <= now
    ) {
      throw new Error(
        "Pairing QR expired. Create a new QR code on your computer.",
      );
    }

    return offer;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Pairing QR expired")
    )
      throw error;

    throw new Error("This is not a valid Paws pairing QR code.");
  }
}

async function json<T>(
  address: string,
  path: string,
  schema: Schema.Codec<T>,
  input: unknown,
  request: RemoteRequest,
  signal?: AbortSignal,
) {
  const response = await request(`${environmentOrigin(address)}${path}`, {
    ...(input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
    credentials: "omit",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });

  if (!response.ok)
    throw new Error(
      "Could not pair. Check sharing on your computer and try again.",
    );

  return Schema.decodeUnknownSync(schema)(await response.json());
}

async function verifyIdentity(
  address: string,
  expectedId: string,
  request: RemoteRequest,
  signal?: AbortSignal,
) {
  const identity = await json(
    address,
    "/identity",
    EnvironmentIdentity,
    undefined,
    request,
    signal,
  );

  if (identity.id !== expectedId)
    throw new Error(
      "Computer identity changed. Discover it or scan its QR again.",
    );

  return identity;
}

export async function pairEnvironment(
  address: string,
  offer: Pick<PairingOffer, "identity" | "code">,
  identity: EnvironmentIdentity,
  signal?: AbortSignal,
  request: RemoteRequest = fetch,
): Promise<RemoteConnection> {
  const origin = environmentOrigin(address);
  await verifyIdentity(origin, offer.identity.id, request, signal);
  const paired = await json(
    origin,
    "/pair",
    PairedEnvironment,
    { code: offer.code, identity, expectedId: offer.identity.id },
    request,
    signal,
  );

  if (paired.identity.id !== offer.identity.id)
    throw new Error("Computer identity changed. Scan its QR again.");

  return {
    origin,
    session: paired.token,
    kind: "environment",
    identity: paired.identity,
  };
}

export async function requestEnvironmentPairing(
  peer: DiscoveredEnvironment,
  identity: EnvironmentIdentity,
  signal?: AbortSignal,
  request: RemoteRequest = fetch,
) {
  await verifyIdentity(peer.url, peer.id, request, signal);

  return json(
    peer.url,
    "/pair/request",
    PairingTicket,
    { identity, expectedId: peer.id },
    request,
    signal,
  );
}

export async function claimEnvironmentPairing(
  peer: DiscoveredEnvironment,
  ticket: PairingTicket,
  signal?: AbortSignal,
  request: RemoteRequest = fetch,
) {
  const result = await json(
    peer.url,
    "/pair/claim",
    PairingClaim,
    { id: ticket.id, secret: ticket.secret },
    request,
    signal,
  );

  if (result.status === "approved" && result.identity.id !== peer.id)
    throw new Error("Computer identity changed. Discover it again.");

  return result;
}

export async function cancelEnvironmentPairing(
  peer: DiscoveredEnvironment,
  ticket: PairingTicket,
) {
  await json(
    peer.url,
    "/pair/cancel",
    Schema.Struct({ cancelled: Schema.Boolean }),
    { id: ticket.id, secret: ticket.secret },
    fetch,
  );
}

export async function resolvePairingOffer(
  offer: PairingOffer,
  signal: AbortSignal,
  request: RemoteRequest = fetch,
) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);

  try {
    return await Promise.any(
      offer.addresses.map(async (address) => {
        await verifyIdentity(address, offer.identity.id, request, combined);

        return environmentOrigin(address);
      }),
    );
  } catch {
    throw new Error(
      "Computer unreachable. Connect to the same Wi-Fi or Tailscale network and scan again.",
    );
  } finally {
    controller.abort();
  }
}
