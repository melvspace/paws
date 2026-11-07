import { expect, it, vi } from "vite-plus/test";
import type { PairingOffer } from "@paws/contracts";
import { createRemoteClient, type RemoteRequest } from "./remote.ts";
import {
  claimEnvironmentPairing,
  environmentOrigin,
  pairEnvironment,
  pairingQr,
  parsePairingQr,
  requestEnvironmentPairing,
  resolvePairingOffer,
} from "./pairing.ts";

const identity = { id: "computer", name: "Desktop", platform: "linux" };
const phone = { id: "phone", name: "Pixel", platform: "android" };
const peer = {
  ...identity,
  url: "http://192.168.1.5:4312",
  source: "lan" as const,
};
const offer: PairingOffer = {
  protocol: "paws-pair-v1",
  identity,
  addresses: [peer.url],
  code: "single-use-secret",
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};
const token = "a".repeat(43);

it("round-trips a pairing QR and rejects expired, malformed, and public HTTP offers", () => {
  expect(parsePairingQr(pairingQr(offer))).toEqual(offer);
  expect(() =>
    parsePairingQr(pairingQr(offer), Date.parse(offer.expiresAt)),
  ).toThrow("expired");

  for (const value of [
    "https://example.com/",
    "paws://pair#invalid",
    pairingQr({ ...offer, addresses: ["http://8.8.8.8:4312"] }),
    pairingQr({ ...offer, addresses: [] }),
  ]) {
    expect(() => parsePairingQr(value)).toThrow("pairing QR");
  }

  for (const url of [
    "http://100.64.0.1:4312",
    "http://172.16.0.1:4312",
    "https://computer.example.test",
  ]) {
    expect(environmentOrigin(url)).toBe(url);
  }

  for (const url of [
    "http://example.test",
    "http://172.32.0.1",
    "http://100.128.0.1",
    "https://user:pass@computer.test",
    "https://computer.test/api",
    "file:///private",
  ]) {
    expect(() => environmentOrigin(url)).toThrow();
  }
});

it("verifies the computer before disclosing a code and pins the paired identity", async () => {
  const request = vi
    .fn<RemoteRequest>()
    .mockResolvedValueOnce(Response.json({ ...identity, id: "wrong" }));
  await expect(
    pairEnvironment(peer.url, offer, phone, undefined, request),
  ).rejects.toThrow("identity changed");
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1].body).toBeUndefined();
  request
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json({ identity, token }));
  const connection = await pairEnvironment(
    peer.url,
    offer,
    phone,
    undefined,
    request,
  );
  expect(connection).toEqual({
    origin: peer.url,
    session: token,
    kind: "environment",
    identity,
  });
  const client = createRemoteClient(connection, request);
  expect(client.socketUrl).toBe("ws://192.168.1.5:4312/ws");
  expect(client.headers).toEqual({
    "X-Paws-Client": "native",
    Authorization: `Bearer ${token}`,
  });
  expect(request.mock.calls[2]?.[1]).toMatchObject({
    credentials: "omit",
    body: JSON.stringify({
      code: offer.code,
      identity: phone,
      expectedId: identity.id,
    }),
  });
});

it("exchanges discovery approval tickets without putting private claim credentials in URLs", async () => {
  const ticket = {
    id: "request",
    identity: phone,
    verificationCode: "123456",
    secret: "private-claim",
    expiresAt: offer.expiresAt,
  };
  const request = vi
    .fn<RemoteRequest>()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json(ticket))
    .mockResolvedValueOnce(
      Response.json({ status: "approved", identity, token }),
    );
  expect(
    await requestEnvironmentPairing(peer, phone, undefined, request),
  ).toEqual(ticket);
  expect(
    await claimEnvironmentPairing(peer, ticket, undefined, request),
  ).toEqual({ status: "approved", identity, token });
  expect(request.mock.calls[2]?.[0]).toBe(`${peer.url}/pair/claim`);
  expect(request.mock.calls[2]?.[1].body).toBe(
    JSON.stringify({ id: ticket.id, secret: ticket.secret }),
  );
  request.mockResolvedValue(
    Response.json({
      status: "approved",
      identity: { ...identity, id: "changed" },
      token,
    }),
  );
  await expect(
    claimEnvironmentPairing(peer, ticket, undefined, request),
  ).rejects.toThrow("identity changed");
});

it("tries the QR's advertised networks and only chooses a matching computer", async () => {
  const request = vi
    .fn<RemoteRequest>()
    .mockImplementation(async (url) =>
      Response.json(
        url.includes("192.168") ? identity : { ...identity, id: "other" },
      ),
    );
  const controller = new AbortController();
  expect(
    await resolvePairingOffer(
      { ...offer, addresses: ["http://10.0.0.1:4312", peer.url] },
      controller.signal,
      request,
    ),
  ).toBe(peer.url);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([, options]) => !options.body)).toBe(true);
});
