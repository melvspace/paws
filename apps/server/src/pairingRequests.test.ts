import { expect, it, vi } from "vite-plus/test";
import { makePairingRequests } from "./pairingRequests.ts";

const phone = { id: "phone", name: "Pixel", platform: "android" };
const computer = { id: "computer", name: "Desktop", platform: "linux" };

it("requires approval and a private claim secret, then retries the same grant safely", async () => {
  const service = makePairingRequests();
  const ticket = service.create(phone);
  const grant = vi
    .fn()
    .mockResolvedValue({ identity: computer, token: "private-token" });
  expect(JSON.stringify(service.list())).not.toContain(ticket.secret);
  expect(service.list()[0]).toMatchObject({
    identity: phone,
    verificationCode: ticket.verificationCode,
  });
  expect(await service.claim(ticket.id, ticket.secret, grant)).toEqual({
    status: "pending",
  });
  expect(grant).not.toHaveBeenCalled();
  await expect(service.claim(ticket.id, "wrong", grant)).rejects.toThrow(
    "expired",
  );
  service.decide(ticket.id, "approve");
  const results = await Promise.all([
    service.claim(ticket.id, ticket.secret, grant),
    service.claim(ticket.id, ticket.secret, grant),
  ]);
  expect(results).toEqual(
    Array(2).fill({
      status: "approved",
      identity: computer,
      token: "private-token",
    }),
  );
  expect(grant).toHaveBeenCalledExactlyOnceWith(phone);
  service.cancel(ticket.id, ticket.secret);
  await expect(service.claim(ticket.id, ticket.secret, grant)).rejects.toThrow(
    "expired",
  );
});

it("expires and bounds requests and clears them when sharing stops", async () => {
  let now = 1000;
  const service = makePairingRequests(() => now);
  const ticket = service.create(phone);
  const grant = vi.fn();
  service.decide(ticket.id, "deny");
  expect(await service.claim(ticket.id, ticket.secret, grant)).toEqual({
    status: "denied",
  });
  expect(grant).not.toHaveBeenCalled();

  for (let i = 0; i < 16; i++) service.create({ ...phone, id: String(i) });

  expect(() => service.create(phone)).toThrow("Too many");
  now += 120001;
  expect(service.list()).toEqual([]);
  expect(() => service.decide(ticket.id, "approve")).toThrow("expired");
  const current = service.create(phone);
  service.clear();
  await expect(
    service.claim(current.id, current.secret, grant),
  ).rejects.toThrow("expired");
});
