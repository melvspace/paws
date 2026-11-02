import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ChatError } from "./ChatService.ts";

export type WebhookHeaders = Record<string, string | string[] | undefined>;
export type WebhookRequest = {
  headers: WebhookHeaders;
  body: Buffer;
  secret: string;
};
export type WebhookDelivery = {
  source: string;
  deliveryId?: string | undefined;
  eventType?: string | undefined;
  ignore?: boolean;
};
export type WebhookAdapter = {
  matches(headers: WebhookHeaders): boolean;
  verify(request: WebhookRequest): WebhookDelivery;
};

function header(headers: WebhookHeaders, name: string) {
  const value = headers[name];

  if (Array.isArray(value))
    throw new ChatError(401, "Repeated webhook headers are not supported.");

  return value;
}

function equal(expected: string, received: string | undefined) {
  if (received === undefined) return false;

  const left = Buffer.from(expected);
  const right = Buffer.from(received);

  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(valid: boolean) {
  if (!valid) throw new ChatError(401, "Invalid webhook signature or token.");
}

function gitlabMetadata(headers: WebhookHeaders) {
  return {
    source: "gitlab",
    eventType: header(headers, "x-gitlab-event"),
    deliveryId:
      header(headers, "webhook-id") ?? header(headers, "idempotency-key"),
  };
}

const standard: WebhookAdapter = {
  matches: (headers) =>
    headers["webhook-signature"] !== undefined ||
    (headers["x-gitlab-token"] === undefined &&
      (headers["webhook-id"] !== undefined ||
        headers["webhook-timestamp"] !== undefined)),
  verify: ({ headers, body, secret }) => {
    const id = header(headers, "webhook-id");
    const timestamp = header(headers, "webhook-timestamp");
    const signatures = header(headers, "webhook-signature");

    if (
      !id ||
      !/^[a-zA-Z0-9_:-]{1,200}$/.test(id) ||
      !timestamp ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300000
    )
      throw new ChatError(401, "Invalid webhook ID or timestamp.");

    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key)
      .update(`${id}.${timestamp}.`)
      .update(body)
      .digest("base64");
    authenticate(
      key.length > 0 &&
        !!signatures
          ?.split(" ")
          .some((value) => equal(`v1,${expected}`, value)),
    );

    return {
      source: "standard",
      deliveryId: id,
      eventType: header(headers, "x-gitlab-event"),
    };
  },
};

const github: WebhookAdapter = {
  matches: (headers) =>
    [
      "x-hub-signature-256",
      "x-hub-signature",
      "x-github-event",
      "x-github-delivery",
    ].some((name) => headers[name] !== undefined),
  verify: ({ headers, body, secret }) => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    authenticate(
      equal(`sha256=${expected}`, header(headers, "x-hub-signature-256")),
    );
    const eventType = header(headers, "x-github-event");

    return {
      source: "github",
      deliveryId: header(headers, "x-github-delivery"),
      eventType,
      ignore: eventType === "ping",
    };
  },
};

const gitlab: WebhookAdapter = {
  matches: (headers) =>
    ["x-gitlab-token", "x-gitlab-event", "x-gitlab-webhook-uuid"].some(
      (name) => headers[name] !== undefined,
    ),
  verify: ({ headers, secret }) => {
    authenticate(equal(secret, header(headers, "x-gitlab-token")));

    return gitlabMetadata(headers);
  },
};

const bearer: WebhookAdapter = {
  matches: () => true,
  verify: ({ headers, secret }) => {
    const authorization = header(headers, "authorization");
    const token = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
    authenticate(equal(secret, token));

    return {
      source: "generic",
      deliveryId: header(headers, "idempotency-key"),
    };
  },
};

// A recognized format must verify successfully; never fall back after failure.
export const webhookAdapters: readonly WebhookAdapter[] = [
  standard,
  github,
  gitlab,
  bearer,
];

export function verifyWebhook(
  request: WebhookRequest,
  adapters = webhookAdapters,
) {
  const adapter = adapters.find((candidate) =>
    candidate.matches(request.headers),
  );

  if (!adapter) throw new ChatError(401, "Unsupported webhook authentication.");

  const delivery = adapter.verify(request);

  if (
    delivery.deliveryId !== undefined &&
    !/^[a-zA-Z0-9_.:-]{1,200}$/.test(delivery.deliveryId)
  )
    throw new ChatError(400, "Invalid delivery ID.");

  return delivery;
}

export function webhookSecret(value?: string) {
  if (value === undefined) return `whsec_${randomBytes(32).toString("base64")}`;
  if (!value.length || value.length > 1024 || /\s/.test(value))
    throw new ChatError(
      400,
      "Use a webhook secret of 1–1024 characters without whitespace.",
    );

  return value;
}
