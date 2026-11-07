import { Schema } from "effect";
import {
  EnvironmentState,
  EnvironmentDiscovery,
  PairingCode,
  PairingRequests,
  type PairEnvironment,
} from "@paws/contracts";

async function request(path = "", method = "GET", input?: unknown) {
  const response = await fetch(`/api/environments${path}`, {
    method,
    ...(input !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const result: unknown = await response.json();

  if (!response.ok) {
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(result);

    throw new Error(error.error);
  }

  return result;
}

export async function loadEnvironments() {
  return Schema.decodeUnknownSync(EnvironmentState)(await request());
}

export async function configureEnvironment(input: {
  name?: string;
  sharing?: boolean;
}) {
  return Schema.decodeUnknownSync(EnvironmentState)(
    await request("", "PATCH", input),
  );
}

export async function discoverEnvironments() {
  return Schema.decodeUnknownSync(EnvironmentDiscovery)(
    await request("/discover", "POST"),
  );
}

export async function createEnvironmentPairing() {
  return Schema.decodeUnknownSync(PairingCode)(
    await request("/pairing", "POST"),
  );
}

export async function linkEnvironment(input: PairEnvironment) {
  return Schema.decodeUnknownSync(EnvironmentState)(
    await request("/link", "POST", input),
  );
}

export async function setEnvironmentEnabled(id: string, enabled: boolean) {
  return Schema.decodeUnknownSync(EnvironmentState)(
    await request(`/links/${encodeURIComponent(id)}`, "PATCH", { enabled }),
  );
}

export async function removeEnvironment(
  kind: "links" | "connections",
  id: string,
) {
  return Schema.decodeUnknownSync(EnvironmentState)(
    await request(`/${kind}/${encodeURIComponent(id)}`, "DELETE"),
  );
}

export * from "./transport.ts";

export async function loadPairingRequests() {
  return Schema.decodeUnknownSync(PairingRequests)(await request("/requests"));
}

export async function decidePairingRequest(
  id: string,
  decision: "approve" | "deny",
) {
  return Schema.decodeUnknownSync(PairingRequests)(
    await request("/requests", "POST", { id, decision }),
  );
}
