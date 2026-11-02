import { createHmac } from "node:crypto";
import { expect, it } from "vite-plus/test";
import {
  verifyWebhook,
  webhookSecret,
  type WebhookHeaders,
} from "./webhooks.ts";

const secret = "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==";
const body = Buffer.from('{ "type": "issue.created", "title": "猫" }');

function standardHeaders(
  timestamp = String(Math.floor(Date.now() / 1000)),
  id = "msg_123",
): WebhookHeaders {
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");

  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,old-signature v1,${signature}`,
  };
}

it("verifies GitHub's published signature vector without a custom protocol", () => {
  const delivery = verifyWebhook({
    secret: "It's a Secret to Everybody",
    body: Buffer.from("Hello, World!"),
    headers: {
      "x-hub-signature-256":
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
    },
  });
  expect(delivery).toMatchObject({
    source: "github",
    eventType: "issues",
    deliveryId: "delivery-1",
  });
});

it("verifies Standard Webhooks with rotating signatures and the exact raw bytes", () => {
  const headers = standardHeaders();
  expect(verifyWebhook({ headers, body, secret })).toEqual({
    source: "standard",
    deliveryId: "msg_123",
  });
  expect(verifyWebhook({ headers, body, secret: secret.slice(6) }).source).toBe(
    "standard",
  );
  expect(() =>
    verifyWebhook({
      headers,
      body: Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
      secret,
    }),
  ).toThrow("signature");

  for (const change of [
    { "webhook-id": "different" },
    { "webhook-signature": "v1,invalid" },
    { "webhook-signature": ["v1,invalid"] },
    { "webhook-timestamp": "NaN" },
  ]) {
    expect(() =>
      verifyWebhook({ headers: { ...headers, ...change }, body, secret }),
    ).toThrow();
  }
});

it.each([-301, 301])(
  "rejects Standard Webhooks timestamps offset by %s seconds",
  (offset) => {
    const timestamp = String(Math.floor(Date.now() / 1000) + offset);
    expect(() =>
      verifyWebhook({ headers: standardHeaders(timestamp), body, secret }),
    ).toThrow("timestamp");
  },
);

it("recognizes both GitLab secret tokens and signed Standard Webhooks", () => {
  const metadata = {
    "x-gitlab-event": "Merge Request Hook",
    "idempotency-key": "delivery-1",
    "x-gitlab-webhook-uuid": "hook-1",
  };
  const legacy = {
    ...metadata,
    "x-gitlab-token": secret,
    "webhook-id": "delivery-1",
    "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
  };
  expect(verifyWebhook({ headers: legacy, body, secret })).toEqual({
    source: "gitlab",
    eventType: "Merge Request Hook",
    deliveryId: "delivery-1",
  });
  expect(
    verifyWebhook({
      headers: { ...metadata, "x-gitlab-token": secret },
      body,
      secret,
    }).deliveryId,
  ).toBe("delivery-1");
  expect(
    verifyWebhook({
      headers: { ...legacy, ...standardHeaders() },
      body,
      secret,
    }),
  ).toMatchObject({ source: "standard", deliveryId: "msg_123" });
  expect(() =>
    verifyWebhook({
      headers: {
        ...legacy,
        ...standardHeaders(),
        "webhook-signature": "v1,bad",
      },
      body,
      secret,
    }),
  ).toThrow("signature");
});

it("accepts ordinary bearer authentication and optional idempotency keys", () => {
  const headers = { authorization: `bearer ${secret}` };
  expect(verifyWebhook({ headers, body, secret })).toEqual({
    source: "generic",
  });
  expect(
    verifyWebhook({
      headers: { ...headers, "idempotency-key": "retry-1" },
      body,
      secret,
    }).deliveryId,
  ).toBe("retry-1");
  expect(() => verifyWebhook({ headers: {}, body, secret })).toThrow("token");
  expect(() =>
    verifyWebhook({ headers: { authorization: "Bearer wrong" }, body, secret }),
  ).toThrow("token");
  expect(() =>
    verifyWebhook({
      headers: { ...headers, "idempotency-key": "" },
      body,
      secret,
    }),
  ).toThrow("delivery ID");
});

it.each([
  { "x-hub-signature-256": "sha256=bad" },
  { "x-hub-signature": "sha1=bad" },
  { "x-github-event": "push" },
  { "x-gitlab-token": "wrong" },
  { "x-gitlab-event": "Push Hook" },
  { "webhook-signature": "v1,bad" },
  { "webhook-id": "unsigned" },
])(
  "does not fall back to bearer authentication for recognized headers %j",
  (headers) => {
    expect(() =>
      verifyWebhook({
        headers: { ...headers, authorization: `Bearer ${secret}` },
        body,
        secret,
      }),
    ).toThrow();
  },
);

it("allows adding an adapter without changing routine execution", () => {
  const delivery = { source: "example", deliveryId: "1", eventType: "created" };
  expect(
    verifyWebhook({ headers: {}, body, secret }, [
      { matches: () => true, verify: () => delivery },
    ]),
  ).toEqual(delivery);
});

it("generates standard signing secrets and validates imported sender secrets", () => {
  expect(webhookSecret()).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  expect(webhookSecret(secret)).toBe(secret);

  for (const invalid of ["", "has whitespace", "a".repeat(1025)]) {
    expect(() => webhookSecret(invalid)).toThrow("secret");
  }
});
