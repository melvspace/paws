import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  EnvironmentIdentity,
  PairingRequest,
  PairedEnvironment,
} from "@paws/contracts";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function makePairingRequests(now = Date.now) {
  const requests = new Map<
    string,
    {
      public: PairingRequest;
      digest: Buffer;
      status: "pending" | "approved" | "denied";
      grant?: Promise<typeof PairedEnvironment.Type>;
    }
  >();

  function prune() {
    for (const [id, request] of requests) {
      if (Date.parse(request.public.expiresAt) <= now()) requests.delete(id);
    }
  }

  function authenticated(id: string, secret: string) {
    prune();
    const request = requests.get(id);

    if (!request || !timingSafeEqual(request.digest, digest(secret))) {
      throw new Error("Pairing request expired. Try connecting again.");
    }

    return request;
  }

  return {
    create(identity: EnvironmentIdentity) {
      prune();

      if (requests.size >= 16)
        throw new Error("Too many pairing requests. Try again shortly.");

      const secret = randomBytes(32).toString("base64url");
      const request: PairingRequest = {
        id: randomUUID(),
        identity,
        verificationCode: String(randomInt(100000, 1000000)),
        expiresAt: new Date(now() + 120_000).toISOString(),
      };
      requests.set(request.id, {
        public: request,
        digest: digest(secret),
        status: "pending",
      });

      return { ...request, secret };
    },
    list() {
      prune();

      return [...requests.values()]
        .filter((request) => request.status === "pending")
        .map((request) => request.public);
    },
    decide(id: string, decision: "approve" | "deny") {
      prune();
      const request = requests.get(id);

      if (!request || request.status !== "pending")
        throw new Error("Pairing request expired. Ask the phone to reconnect.");

      request.status = decision === "approve" ? "approved" : "denied";
    },
    async claim(
      id: string,
      secret: string,
      grant: (
        identity: EnvironmentIdentity,
      ) => Promise<typeof PairedEnvironment.Type>,
    ) {
      const request = authenticated(id, secret);

      if (request.status === "pending") return { status: "pending" as const };

      if (request.status === "denied") {
        requests.delete(id);

        return { status: "denied" as const };
      }

      // Keep the approved result until the phone acknowledges or the ticket
      // expires. Retrying a lost response must not rotate the device token.
      request.grant ??= grant(request.public.identity);

      return { status: "approved" as const, ...(await request.grant) };
    },
    cancel(id: string, secret: string) {
      authenticated(id, secret);
      requests.delete(id);
    },
    clear: () => requests.clear(),
  };
}
